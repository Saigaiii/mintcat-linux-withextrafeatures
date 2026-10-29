/**
 * Update checks for local mods that come from a Pak Hub style repository.
 *
 * A local mod is "linked" to a repository post + file name. Links are made when a mod is
 * added from a repository, automatically by matching the mod's file name, or by hand
 * (right-click → Link to Pak Hub post…, which also covers renamed files).
 *
 * Updating downloads the newest upload of that file into MintCat's data folder and points
 * the mod at it; a file of the user's own (outside that folder) is never modified.
 */
import {t} from "i18next";
import {appDataDir, join} from "@tauri-apps/api/path";
import {exists, mkdir, remove, rename, stat} from "@tauri-apps/plugin-fs";
import {
    ModRepository,
    RepositoryApi,
    RepositoryFile,
    RepositoryStore,
    safeModFileName,
} from "@/apis/repositories";
import {DownloadApi} from "@/apis/DownloadApi";
import {StorageAPI} from "@/storage";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {ModSourceType} from "@/models/mod/types";
import {emitEvent} from "@/events";
import {logActivity} from "@/services/ActivityLog";

export interface RepositoryLink {
    repoId: string;
    slug: string;
    /** File name of the upload this mod corresponds to (as named on the repository) */
    filename: string;
    /** Upload the user has, when known */
    postedAt?: string;
    sizeBytes?: number;
    /** How the link was made */
    via: 'added' | 'auto' | 'manual';
}

export type RepositoryUpdateState =
    | { kind: 'upToDate' }
    | { kind: 'newer'; latest: RepositoryFile }      // a newer upload than the one you have
    | { kind: 'differs'; latest: RepositoryFile };   // your file matches no upload; latest may differ

interface LinkStoreData {
    byMod: Record<string, RepositoryLink>;
    /** Links for freshly downloaded files whose mod id isn't known yet */
    byPath: Record<string, RepositoryLink>;
    /** When a mod was last searched for without a match (to avoid searching every time) */
    noMatch: Record<string, number>;
}

const SETTINGS_KEY = 'repositoryModLinks';
const NO_MATCH_RECHECK_MS = 7 * 24 * 3600 * 1000;
const PARALLEL = 3;

let data: LinkStoreData | null = null;
const updates = new Map<number, RepositoryUpdateState>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
    version++;
    listeners.forEach(l => {
        try {
            l();
        } catch (e) {
            console.error('[RepositoryUpdates] listener failed', e);
        }
    });
}

async function load(): Promise<LinkStoreData> {
    if (data) return data;
    try {
        const settings = await StorageAPI.getSettings();
        const raw = await settings.getValue(SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        data = {byMod: parsed.byMod ?? {}, byPath: parsed.byPath ?? {}, noMatch: parsed.noMatch ?? {}};
    } catch {
        data = {byMod: {}, byPath: {}, noMatch: {}};
    }
    return data;
}

async function save(): Promise<void> {
    if (!data) return;
    const settings = await StorageAPI.getSettings();
    await settings.setValue(SETTINGS_KEY, JSON.stringify(data));
    notify();
}

function fileNameOf(p: string): string {
    return p.split(/[\\/]/).pop() || p;
}

function modPath(mod: CompleteModData): string {
    return mod.download?.cachePath || mod.url || "";
}

function modName(mod: CompleteModData): string {
    return mod.displayName || mod.originalName || fileNameOf(modPath(mod));
}

async function localSize(path: string): Promise<number | undefined> {
    try {
        return (await stat(path)).size;
    } catch {
        return undefined;
    }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({length: Math.min(PARALLEL, items.length)}, async () => {
        while (next < items.length) {
            await worker(items[next++]);
        }
    }));
}

/** Uploads of one file name in a post, newest first */
function uploadsOf(files: RepositoryFile[], filename: string): RepositoryFile[] {
    const key = filename.toLowerCase();
    return files.filter(f => f.filename.toLowerCase() === key);
}

export const RepositoryUpdates = {
    /** Load links (call once at startup so menus know which mods are linked) */
    async init(): Promise<void> {
        await load();
        notify();
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    /** Synchronous lookup for menus/icons (after init) */
    linkForModSync(mod: { modId?: number; url?: string; download?: { cachePath?: string } }): RepositoryLink | undefined {
        if (!data) return undefined;
        return (mod.modId != null ? data.byMod[String(mod.modId)] : undefined)
            ?? data.byPath[mod.download?.cachePath || mod.url || ""];
    },

    updateState(modId: number): RepositoryUpdateState | undefined {
        return updates.get(modId);
    },

    /**
     * For components: pass the version from useSyncExternalStore so the React Compiler
     * recomputes when links/updates change (it caches calls whose inputs didn't change).
     */
    updateStateAt(modId: number, _version: number): RepositoryUpdateState | undefined {
        return updates.get(modId);
    },

    linkForModAt(mod: { modId?: number; url?: string; download?: { cachePath?: string } }, _version: number): RepositoryLink | undefined {
        return this.linkForModSync(mod);
    },

    async getLink(mod: CompleteModData): Promise<RepositoryLink | undefined> {
        const store = await load();
        const byMod = store.byMod[String(mod.modId)];
        if (byMod) return byMod;
        // A file downloaded from a repository before its mod existed: attach the link to the mod now
        const path = modPath(mod);
        const byPath = store.byPath[path];
        if (byPath && mod.modId != null) {
            store.byMod[String(mod.modId)] = byPath;
            delete store.byPath[path];
            await save();
        }
        return byPath;
    },

    /** Remember the repository post a freshly downloaded file came from */
    async rememberDownloadedFile(path: string, link: RepositoryLink): Promise<void> {
        const store = await load();
        store.byPath[path] = link;
        await save();
    },

    async setLink(modId: number, link: RepositoryLink): Promise<void> {
        const store = await load();
        store.byMod[String(modId)] = link;
        delete store.noMatch[String(modId)];
        updates.delete(modId);
        await save();
    },

    async removeLink(modId: number): Promise<void> {
        const store = await load();
        delete store.byMod[String(modId)];
        updates.delete(modId);
        await save();
    },

    /** Forget a downloaded file that was never added (or was deleted) */
    async forgetPath(path: string): Promise<void> {
        const store = await load();
        if (store.byPath[path]) {
            delete store.byPath[path];
            await save();
        }
    },

    /**
     * Find the post a local mod's file came from by its exact file name.
     * Returns the link, 'ambiguous' when several posts could be it, or undefined.
     */
    async autoMatch(mod: CompleteModData, repos: ModRepository[]): Promise<RepositoryLink | 'ambiguous' | undefined> {
        const filename = fileNameOf(modPath(mod));
        if (!safeModFileName(filename)) return undefined;
        const size = await localSize(modPath(mod));

        const candidates: Array<{ repo: ModRepository; slug: string; uploads: RepositoryFile[] }> = [];
        for (const repo of repos) {
            let list;
            try {
                list = await RepositoryApi.listMods(repo, {query: filename, page: 1});
            } catch {
                continue;
            }
            for (const summary of list.mods.slice(0, 5)) {
                try {
                    const detail = await RepositoryApi.getMod(repo, summary.slug);
                    const uploads = uploadsOf(detail.files, filename);
                    if (uploads.length > 0) candidates.push({repo, slug: summary.slug, uploads});
                } catch {
                    // skip unreadable posts
                }
            }
        }
        if (candidates.length === 0) return undefined;

        const sizeMatches = (c: typeof candidates[number]) => size !== undefined && c.uploads.some(u => u.sizeBytes === size);
        let chosen = candidates.length === 1 ? candidates[0] : undefined;
        if (!chosen) {
            const exact = candidates.filter(sizeMatches);
            if (exact.length !== 1) return 'ambiguous';
            chosen = exact[0];
        }
        const mine = size !== undefined ? chosen.uploads.find(u => u.sizeBytes === size) : undefined;
        return {
            repoId: chosen.repo.id,
            slug: chosen.slug,
            filename: chosen.uploads[0].filename,
            postedAt: mine?.postedAt,
            sizeBytes: mine?.sizeBytes,
            via: 'auto',
        };
    },

    /** Compare the mod's file with the newest upload of its file on the repository */
    async check(mod: CompleteModData, link: RepositoryLink): Promise<RepositoryUpdateState> {
        const repo = await RepositoryStore.get(link.repoId);
        if (!repo) throw new Error(t("repo.notFound"));
        const detail = await RepositoryApi.getMod(repo, link.slug);
        const uploads = uploadsOf(detail.files, link.filename);
        if (uploads.length === 0) return {kind: 'upToDate'};
        const latest = uploads[0];
        const size = await localSize(modPath(mod));

        // Learn which upload the user has when the file matches one exactly
        if (!link.postedAt && size !== undefined) {
            const mine = uploads.find(u => u.sizeBytes === size);
            if (mine && mod.modId != null) {
                link.postedAt = mine.postedAt;
                link.sizeBytes = mine.sizeBytes;
                await this.setLink(mod.modId, link);
            }
        }

        let state: RepositoryUpdateState;
        if (link.postedAt) {
            const newer = (Date.parse(latest.postedAt) || 0) > (Date.parse(link.postedAt) || 0);
            state = newer ? {kind: 'newer', latest} : {kind: 'upToDate'};
        } else {
            state = size === latest.sizeBytes ? {kind: 'upToDate'} : {kind: 'differs', latest};
        }
        if (mod.modId != null) {
            if (state.kind === 'upToDate') updates.delete(mod.modId);
            else updates.set(mod.modId, state);
            notify();
        }
        return state;
    },

    /**
     * Download the given upload into MintCat's data folder and point the mod at it.
     */
    async apply(mod: CompleteModData, link: RepositoryLink, upload: RepositoryFile): Promise<void> {
        const name = safeModFileName(upload.filename);
        if (!name || mod.modId == null) throw new Error("invalid file");
        const dir = await join(await appDataDir(), "repository-mods", link.repoId, link.slug);
        await mkdir(dir, {recursive: true});
        const target = await join(dir, name);
        const temp = `${target}.download`;
        if (await exists(temp)) await remove(temp);
        // Download next to the target first, so a failed download never breaks the current file
        await DownloadApi.downloadFile(upload.downloadUrl, temp, {resume: false, retryCount: 2});
        await rename(temp, target);

        const info = await stat(target);
        const modsApi = await StorageAPI.getMods();
        const previousPath = modPath(mod);
        await modsApi.updateMod(mod.modId, {url: target});
        await modsApi.upsertModDownload({modId: mod.modId, cachePath: target, fileSize: info.size, downloadProgress: 100});
        await modsApi.upsertModStatus({modId: mod.modId, lastUpdateDate: info.mtime?.getTime() ?? Date.now(), isLocalNotFound: false});

        await this.setLink(mod.modId, {...link, postedAt: upload.postedAt, sizeBytes: upload.sizeBytes});
        updates.delete(mod.modId);
        notify();

        // An earlier download with a different file name is no longer used
        if (previousPath && previousPath !== target && !(await modsApi.getModByUrl(previousPath))) {
            const {deleteRepositoryFile} = await import("@/services/RepositoryModCleanup");
            await deleteRepositoryFile(previousPath).catch(() => false);
        }

        const updated = await modsApi.getCompleteModData(mod.modId);
        if (updated) await emitEvent("mod-treeview-update", {modId: mod.modId, data: updated});
        await logActivity('success', t("repoUpdate.updated", {name: modName(mod), date: new Date(upload.postedAt).toLocaleString()}), target, 'repository');
    },

    /**
     * Update button: check every local mod, link unlinked ones when possible, and apply
     * updates whose current version is known. Returns counts for a summary.
     */
    async checkAll(mods: CompleteModData[]): Promise<{ updated: number; flagged: number; linked: number }> {
        const repos = await RepositoryStore.list();
        const result = {updated: 0, flagged: 0, linked: 0};
        if (repos.length === 0) return result;

        const store = await load();
        const localMods = mods.filter(m => m.sourceType === ModSourceType.Local && m.modId != null);

        await runPool(localMods, async (mod) => {
            try {
                if (!(await exists(modPath(mod)))) return;
                let link = await this.getLink(mod);
                if (!link) {
                    const lastMiss = store.noMatch[String(mod.modId)] ?? 0;
                    if (Date.now() - lastMiss < NO_MATCH_RECHECK_MS) return;
                    const match = await this.autoMatch(mod, repos);
                    if (match === 'ambiguous') {
                        await logActivity('info', t("repoUpdate.ambiguous", {name: modName(mod)}), modPath(mod), 'repository');
                        store.noMatch[String(mod.modId)] = Date.now();
                        return;
                    }
                    if (!match) {
                        store.noMatch[String(mod.modId)] = Date.now();
                        return;
                    }
                    link = match;
                    await this.setLink(mod.modId!, link);
                    result.linked++;
                    await logActivity('info', t("repoUpdate.linked", {name: modName(mod)}), RepositoryApi.modPageUrl(repos.find(r => r.id === link!.repoId)!, link.slug), 'repository');
                }

                const state = await this.check(mod, link);
                if (state.kind === 'newer') {
                    await this.apply(mod, link, state.latest);
                    result.updated++;
                } else if (state.kind === 'differs') {
                    result.flagged++;
                    await logActivity('warning', t("repoUpdate.differs", {name: modName(mod)}), modPath(mod), 'repository');
                }
            } catch (error) {
                await logActivity('error', t("repoUpdate.failed", {name: modName(mod), reason: String(error)}), modPath(mod), 'repository');
            }
        });
        await save();
        return result;
    },

    /**
     * Right-click → Update on a local mod: apply the newest upload even when the current
     * version isn't known (the user asked for it).
     */
    async updateOne(mod: CompleteModData): Promise<'updated' | 'upToDate' | 'notLinked'> {
        let link = await this.getLink(mod);
        if (!link) {
            const match = await this.autoMatch(mod, await RepositoryStore.list());
            if (!match || match === 'ambiguous') return 'notLinked';
            link = match;
            await this.setLink(mod.modId!, link);
        }
        const state = await this.check(mod, link);
        if (state.kind === 'upToDate') return 'upToDate';
        await this.apply(mod, link, state.latest);
        return 'updated';
    },
};
