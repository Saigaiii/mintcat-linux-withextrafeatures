/**
 * Files MintCat downloaded from a repository (Pak Hub etc.) live in its own data folder:
 *   <app data>/repository-mods/<repo>/<post>/<file>
 * When such a mod is removed from the list and no other profile uses it, the downloaded
 * file, its now-empty folders and the mod's record are deleted. Files anywhere else (the
 * user's own .paks) are never touched.
 */
import {t} from "i18next";
import {appDataDir, join} from "@tauri-apps/api/path";
import {exists, readDir, remove} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";
import {ModSourceType} from "@/models/mod/types";
import {logActivity} from "@/services/ActivityLog";
import {fileNameOf, localModPath, parentDir} from "@/services/LocalModRelocation";

function normalize(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The repository download folder, e.g. ~/.local/share/com.mint.cat/repository-mods */
export async function repositoryDownloadRoot(): Promise<string> {
    return await join(await appDataDir(), "repository-mods");
}

/** True when `filePath` is inside MintCat's repository download folder */
export async function isRepositoryDownload(filePath: string): Promise<boolean> {
    if (!filePath) return false;
    const file = normalize(filePath);
    if (file.split("/").includes("..")) return false;
    const root = normalize(await repositoryDownloadRoot());
    return file.startsWith(root + "/");
}

async function usedByAnyProfile(modId: number): Promise<boolean> {
    const profiles = await StorageAPI.getProfiles();
    for (const profile of await profiles.getAllProfiles()) {
        if (profile.id == null) continue;
        const mods = await profiles.getProfileMods(profile.id);
        if (mods.some(m => m.modId === modId)) return true;
    }
    return false;
}

/** Delete a downloaded file and the empty folders above it, up to the download root */
export async function deleteRepositoryFile(filePath: string): Promise<boolean> {
    if (!await isRepositoryDownload(filePath)) return false;
    const root = normalize(await repositoryDownloadRoot());
    let removed = false;
    if (await exists(filePath)) {
        await remove(filePath);
        removed = true;
    }
    let dir = parentDir(filePath);
    while (dir && normalize(dir).startsWith(root + "/")) {
        try {
            if (!await exists(dir)) {
                dir = parentDir(dir);
                continue;
            }
            const entries = await readDir(dir);
            if (entries.length > 0) break;
            await remove(dir);
        } catch {
            break;
        }
        dir = parentDir(dir);
    }
    return removed;
}

/**
 * Call after a mod was removed from the active profile. Returns true when its downloaded
 * file was deleted.
 */
export async function cleanupRemovedRepositoryMod(modId: number): Promise<boolean> {
    try {
        const modsApi = await StorageAPI.getMods();
        const mod = await modsApi.getCompleteModData(modId);
        if (!mod || mod.sourceType !== ModSourceType.Local) return false;
        const filePath = localModPath(mod);
        if (!await isRepositoryDownload(filePath)) return false;
        if (await usedByAnyProfile(modId)) return false;

        const deleted = await deleteRepositoryFile(filePath);
        await modsApi.deleteMod(modId);
        // Forget its repository link too (imported lazily to avoid a load-order cycle)
        const {RepositoryUpdates} = await import("@/services/RepositoryUpdates");
        await RepositoryUpdates.removeLink(modId).catch(() => undefined);
        await RepositoryUpdates.forgetPath(filePath).catch(() => undefined);
        await logActivity('info', t("repo.removedDownload", {name: mod.displayName || fileNameOf(filePath)}), filePath, 'repository');
        return deleted;
    } catch (error) {
        console.warn('[RepositoryModCleanup] cleanup failed for mod', modId, error);
        return false;
    }
}
