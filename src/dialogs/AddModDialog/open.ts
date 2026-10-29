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
import type {AddModFromPathResult} from "@/services/HomeService.ts";
import {exists} from "@tauri-apps/plugin-fs";
import {path as tauriPath} from "@tauri-apps/api";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {isModArchivePath, parseLocalPathLine, splitLines} from "@/utils/LocalModPaths";

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

                if (localList.length > 0) {
                    const pathResults: AddModFromPathResult[] = [];
                    for (const item of localList) {
                        pathResults.push(await vm.addModFromPath(item, result.groupId));
                    }
                    const existsCount = pathResults.filter((r) => r.status === "exists").length;
                    if (existsCount > 0) {
                        message.warning(t("Mod Already Exists") + ` (${existsCount} ${t("in current list")})`);
                    }
                }
                if (onlineList.length > 0) {
                    await addOnlineMods(vm, onlineList, result.groupId);
                }
            }
                break;
            default:
                break;
        }

        await StatusBar.success(t("Add Complete"));
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

type NexusModsParsedUrl = NonNullable<ReturnType<typeof NexusModsApi.parseModLinks>>;

async function addOnlineMods(vm: HomeViewModel, list: string[], groupId: number): Promise<void> {
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
    let errorCount = 0;

    if (directAddList.length > 0) {
        const directResult = await asyncPoolAll(
            directAddList,
            (item) => vm.addModFromUrl(item, groupId),
            5
        );
        results.push(...directResult.results.filter(Boolean));
        errorCount += directResult.errors.length;
    }

    for (const item of nexusWebviewList) {
        try {
            const addModUrl = await captureNexusDownloadUrl(item.url, { parsed: item.parsed });
            results.push(await vm.addModFromUrl(addModUrl, groupId));
        } catch (error) {
            errorCount++;
            console.error('[AddModDialog] Failed to capture Nexus Mods download URL:', error);
            message.error(error instanceof Error ? error.message : t('nexusmods.resolveNxmFailed'));
        }
    }

    const existsCount = results.filter((r) => r?.status === "exists").length;
    if (existsCount > 0) {
        message.warning(t("Mod Already Exists") + ` (${existsCount} ${t("in current list")})`);
    }
    if (errorCount > 0) {
        message.warning(t("mod.someFailedToAdd") + `: ${errorCount}/${list.length}`);
    }

    await downloadNexusModsAfterAdd(results);
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
        try {
            if (!(await exists(localPath))) {
                return;
            }
        } catch {
            return;
        }
        if (!isModArchivePath(localPath) && !(await isUnpackedModDir(localPath))) {
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
