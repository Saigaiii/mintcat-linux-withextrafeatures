import {t} from "i18next";
import {emitVoidEvent, onceEvent} from "@/events";
import {ModioApi} from "@/apis/modio";
import {ModcatApi} from "@/apis/modcat";
import {NexusModsApi} from "@/apis/nexusmods";
import {captureNexusDownloadUrl} from "@/apis/nexusmods/downloadWebview";
import {HomeViewModel} from "@/pages/HomePage/HomeViewModel.ts";
import { IoC } from "@/core/IoC.ts";
import {emitTo} from "@tauri-apps/api/event";
import {WebviewWindow} from "@tauri-apps/api/webviewWindow";
import {ClipboardApi} from "@/apis/ClipboardApi.ts";
import {AddModType} from "@/dialogs/AddModDialog/index.tsx";
import StatusBar from "@/components/StatusBar.tsx";
import {StorageAPI} from "@/storage";
import {asyncPoolAll} from "@/utils/AsyncPool";
import {message} from "antd";
import {frontendRouteUrl} from "@/utils/FrontendUpdateRuntime.ts";
import {ModUpdateService} from "@/services/ModUpdateService.ts";
import type {AddModFromUrlResult} from "@/services/HomeService.ts";
import {exists} from "@tauri-apps/plugin-fs";
import {path as tauriPath} from "@tauri-apps/api";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {isModArchivePath, parseLocalPathLine, splitLines} from "@/utils/LocalModPaths";
import {ActivityLog, logActivity} from "@/services/ActivityLog";

let windowInstance: WebviewWindow;

type AddModDialogInitData = {
    text: string;
    groupId: number;
    addModType: string;
    paths?: string[];
    revision?: number;
};

export async function openWindow(addModType: string = AddModType.LOCAL,
                                 groupId: number = 0,
                                 text: string = "",
                                 onUpdated?: () => Promise<void>,
                                 paths: string[] = []): Promise<void> {

    const vm = await IoC.get(HomeViewModel);

    // If the dialog is already open, it appends this text/paths instead of replacing
    const initData: AddModDialogInitData = {
        text,
        groupId,
        addModType,
        paths,
        revision: Date.now(),
    };

    const setInitData = (data: AddModDialogInitData) => {
        localStorage.setItem('add-mod-dialog-init-data', JSON.stringify(data));
    };

    const sendInitData = async () => {
        await emitTo('add-mod-dialog', "add-mod-dialog-init-data", initData);
    }

    setInitData(initData);

    if (windowInstance) {
        await sendInitData();
        await windowInstance.show();
        return;
    }

    windowInstance = new WebviewWindow('add-mod-dialog', {
        url: frontendRouteUrl(`/add_mod_dialog?init=${encodeURIComponent(JSON.stringify(initData))}`),
        width: 400,
        height: 620,
        title: t("Add Mod"),
        dragDropEnabled: true,
    });

    windowInstance.once('tauri://destroyed', () => {
        windowInstance = null;
    }).then();

    // ✅ 使用 onceEvent 自动管理类型安全
    await onceEvent('add-mod-dialog-ok', async (result) => {
        // result.list 去重
        result.list = [...new Set(result.list)];
        let addProblems = 0;
        let addExists = 0;
        let addTotal = 0;

        switch (result.addModType) {
            case AddModType.SUBSCRIBED: {
                if (result.modInfoList && result.modInfoList.length > 0) {
                    const batchResult = await vm.addModsFromSubscribed(result.modInfoList, result.groupId);
                    if (batchResult.existsCount > 0) {
                        message.warning(t("Mod Already Exists") + ` (${batchResult.existsCount} ${t("in current list")})`);
                    }
                    if (batchResult.errorCount > 0) {
                        message.warning(t("mod.someFailedToAdd") + `: ${batchResult.errorCount}/${result.modInfoList.length}`);
                    }
                }
                break;
            }
            case AddModType.ONLINE:
            case AddModType.LOCAL: {
                // Add everything gathered in both tabs (copied files and links can pile up together)
                const localList = [...new Set(result.localList
                    ?? (result.addModType === AddModType.LOCAL ? result.list : []))];
                const onlineList = [...new Set(result.onlineList
                    ?? (result.addModType === AddModType.ONLINE ? result.list : []))];

                const outcomes: AddOutcome[] = [];
                if (localList.length > 0) {
                    outcomes.push(await addLocalMods(vm, localList, result.groupId));
                }
                if (onlineList.length > 0) {
                    outcomes.push(await addOnlineMods(vm, onlineList, result.groupId));
                }
                addProblems = outcomes.reduce((n, o) => n + o.problems, 0);
                addExists = outcomes.reduce((n, o) => n + o.exists, 0);
                addTotal = localList.length + onlineList.length;
            }
                break;
            default:
                break;
        }

        if (addProblems > 0) {
            // Say how many failed and show the Log with the exact links/files
            message.error(t("addMod.someFailed", {count: addProblems, total: addTotal}));
            ActivityLog.setOpen(true);
            await StatusBar.warning(t("addMod.finishedWithProblems", {count: addProblems}));
        } else {
            await StatusBar.success(t("Add Complete"));
        }
        if (addExists > 0) {
            message.warning(t("Mod Already Exists") + ` (${addExists} ${t("in current list")})`);
        }
        await emitVoidEvent('mods-added');
        if (onUpdated) {
            await onUpdated();
        }

        await windowInstance.close();
        windowInstance = null;
    });

    await onceEvent('add-mod-dialog-close', async () => {
        await windowInstance.close();
        windowInstance = null;
    });

}

type AddOutcome = { problems: number; exists: number };

type NexusModsParsedUrl = NonNullable<ReturnType<typeof NexusModsApi.parseModLinks>>;

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function fileNameOf(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/**
 * Add local files one by one, logging each outcome.
 * @returns how many could not be added / were already listed
 */
async function addLocalMods(vm: HomeViewModel, list: string[], groupId: number): Promise<AddOutcome> {
    let problems = 0;
    let exists = 0;
    for (const item of list) {
        try {
            const r = await vm.addModFromPath(item, groupId);
            if (r.status === "added") {
                await logActivity('success', t("addMod.log.added", {name: fileNameOf(item)}), item, 'add-mod');
            } else if (r.status === "exists") {
                exists++;
                await logActivity('info', t("addMod.log.alreadyInList", {name: fileNameOf(item)}), item, 'add-mod');
            } else {
                problems++;
                await logActivity('error', t("addMod.log.fileNotFound"), item, 'add-mod');
            }
        } catch (error) {
            problems++;
            console.error('[AddModDialog] Failed to add local mod:', item, error);
            await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item, 'add-mod');
        }
    }
    return {problems, exists};
}

async function logLinkResult(url: string, r: AddModFromUrlResult | undefined): Promise<'added' | 'exists' | 'problem'> {
    const name = r?.modName || r?.mod?.displayName;
    if (r?.status === "added") {
        await logActivity('success', t("addMod.log.added", {name: name || url}), url, 'add-mod');
        return 'added';
    }
    if (r?.status === "exists") {
        await logActivity('info', t("addMod.log.alreadyInList", {name: name || url}), url, 'add-mod');
        return 'exists';
    }
    // The lookup itself failed (network, mod.io login...): say why instead of blaming the link
    if (r?.error) {
        await logActivity('error', t("addMod.log.failed", {reason: r.error}), url, 'add-mod');
        return 'problem';
    }
    // "invalid": the link isn't a mod link we understand, or no mod exists at it
    if (!isModLink(url)) {
        await logActivity('error', t("addMod.log.notAModLink"), url, 'add-mod');
    } else {
        await logActivity('error', t("addMod.log.modNotFound"), url, 'add-mod');
    }
    return 'problem';
}

/**
 * Add links, logging each outcome (added mod's name, already listed, not found, error).
 * @returns how many could not be added / were already listed
 */
async function addOnlineMods(vm: HomeViewModel, list: string[], groupId: number): Promise<AddOutcome> {
    const directAddList: string[] = [];
    const nexusWebviewList: Array<{ url: string; parsed: NexusModsParsedUrl }> = [];

    for (const item of list) {
        const parsed = NexusModsApi.parseModLinks(item);
        if (parsed && !NexusModsApi.hasReusableDownloadCredential(item)) {
            nexusWebviewList.push({ url: item, parsed });
        } else {
            directAddList.push(item);
        }
    }

    const results: AddModFromUrlResult[] = [];
    let problems = 0;
    let exists = 0;
    const count = (outcome: 'added' | 'exists' | 'problem') => {
        if (outcome === 'problem') problems++;
        if (outcome === 'exists') exists++;
    };

    if (directAddList.length > 0) {
        const directResult = await asyncPoolAll(
            directAddList,
            async (item) => {
                try {
                    const r = await vm.addModFromUrl(item, groupId);
                    count(await logLinkResult(item, r));
                    return r;
                } catch (error) {
                    problems++;
                    await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item, 'add-mod');
                    throw error;
                }
            },
            5
        );
        results.push(...directResult.results.filter(Boolean));
    }

    for (const item of nexusWebviewList) {
        try {
            const addModUrl = await captureNexusDownloadUrl(item.url, { parsed: item.parsed });
            const r = await vm.addModFromUrl(addModUrl, groupId);
            count(await logLinkResult(item.url, r));
            results.push(r);
        } catch (error) {
            problems++;
            console.error('[AddModDialog] Failed to capture Nexus Mods download URL:', error);
            await logActivity('error', t("addMod.log.failed", {reason: errorText(error)}), item.url, 'add-mod');
        }
    }

    await downloadNexusModsAfterAdd(results);
    return {problems, exists};
}

async function downloadNexusModsAfterAdd(results: AddModFromUrlResult[]): Promise<void> {
    const nexusDownloadMods = results
        .filter((r) => r?.downloadAfterAdd && r.mod)
        .map((r) => r.mod!);
    if (nexusDownloadMods.length === 0) {
        return;
    }

    const { errors: downloadErrors } = await asyncPoolAll(
        nexusDownloadMods,
        async (mod) => {
            if (await ModUpdateService.needsOnlineModDownload(mod)) {
                await StatusBar.info(t("Batch downloading mod", { name: mod.displayName }));
                await ModUpdateService.updateModFile(mod);
            }
        },
        2
    );
    if (downloadErrors.length > 0) {
        message.warning(t("mod.someFailedToAdd") + `: ${downloadErrors.length}/${nexusDownloadMods.length}`);
    }
}

function isModLink(link: string): boolean {
    return !!ModioApi.parseModLinks(link)
        || ModcatApi.isModcatLink(link)
        || NexusModsApi.isNexusModsLink(link);
}

async function isUnpackedModDir(dirPath: string): Promise<boolean> {
    try {
        return await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', {path: dirPath});
    } catch {
        return false;
    }
}

async function onClipboardChange(text: string) {
    if (!text) {
        return;
    }
    const lines = splitLines(text);
    if (lines.length === 0) {
        return;
    }

    let homeDir: string | undefined;
    try {
        homeDir = await tauriPath.homeDir();
    } catch {
        homeDir = undefined;
    }

    // Every line must be a mod link or an existing local mod (.pak/.zip/unpacked folder);
    // anything else means the user copied something unrelated, so ignore it.
    const links: string[] = [];
    const paths: string[] = [];
    for (const line of lines) {
        if (isModLink(line)) {
            links.push(line);
            continue;
        }
        const localPath = parseLocalPathLine(line, homeDir);
        if (!localPath) {
            return;
        }
        // The game's own paks (copied when setting the game path) are not mods
        const normalized = localPath.replace(/\\/g, "/").toLowerCase();
        if (normalized.endsWith("/fsd-windowsnoeditor.pak")
            || normalized.includes("/fsd/content/paks/")
            || normalized.includes("/roguecore/content/paks/")) {
            return;
        }
        let present = false;
        try {
            present = await exists(localPath);
        } catch {
            present = false;
        }
        // A .pak/.zip path is taken even when nothing is there, so the dialog can show it as "Not found";
        // a folder must be an existing unpacked mod (otherwise this is unrelated clipboard text)
        if (!isModArchivePath(localPath) && !(present && await isUnpackedModDir(localPath))) {
            return;
        }
        paths.push(localPath);
    }

    if (links.length === 0 && paths.length === 0) {
        return;
    }

    const addModType = links.length > 0 ? AddModType.ONLINE : AddModType.LOCAL;
    openWindow(addModType, 0, links.join("\n"), undefined, paths).then();
}


export async function initClipboardWatcher() {
    const settings = await StorageAPI.getSettings();
    const enabled = await settings.getClipboardMonitorEnabled();
    if (enabled) {
        await ClipboardApi.setClipboardWatcher(onClipboardChange);
    } else {
        // 仍然注册回调，但不启动监控
        ClipboardApi.setClipboardWatcher(onClipboardChange).then(() => {
            ClipboardApi.stopClipboardWatcher();
        });
    }
}
