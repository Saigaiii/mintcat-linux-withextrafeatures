import {getCurrentWindow} from "@tauri-apps/api/window";
import React from "react";
import i18next, {t} from "i18next";
import {open as openFileDialog, save} from "@tauri-apps/plugin-dialog";
import {copyFile, exists} from "@tauri-apps/plugin-fs";
import {
    Button, Checkbox, Divider, Dropdown,
    Flex, MenuProps, message, Select,
    SelectProps, Space, Spin, Tooltip, TreeProps, Typography,
} from 'antd';
import {
    CheckSquareOutlined, ClearOutlined, CloseCircleOutlined, CloseOutlined, CopyOutlined,
    DeleteOutlined,
    EditOutlined, FieldTimeOutlined, LoadingOutlined, MinusSquareOutlined, PauseCircleOutlined, PlayCircleOutlined,
    PlusCircleOutlined, SaveOutlined, SortAscendingOutlined, SortDescendingOutlined, SyncOutlined, FolderOpenOutlined, ImportOutlined,
    UnorderedListOutlined, WarningOutlined, FolderOutlined, ColumnHeightOutlined, VerticalAlignMiddleOutlined
} from "@ant-design/icons";
import * as checkbox from "antd/es/checkbox";

import {openWindow} from "@/dialogs/AddModDialog/open";
import ProfileEditDialog from "@/dialogs/ProfileEditDialog/index.tsx";
import {InputDialog} from "@/dialogs/InputDialog.tsx";
import {FOLDER_COLOR_PREFIX, TreeViewConverter} from "./TreeViewConverter.ts";
import {ModListAppearance} from "@/services/ModListAppearance";
import {TreeViewOutlined} from "@/components/SvgIcon.tsx";
import {MessageBox} from "@/components/MessageBox.ts";
import {ModUpdateService} from "@/services/ModUpdateService.ts";
import {IntegrateApi} from "@/apis/IntegrateApi.ts";
import {ClipboardApi} from "@/apis/ClipboardApi.ts";
import {autoBind} from "@/utils/ReactUtils.ts";
import {HomeViewModel} from "./HomeViewModel.ts";
import {LastGroupCannotDeleteError} from "@/services/HomeService.ts";
import {TreeViewModel} from "./TreeViewModel.ts";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel.ts";
import {CountLabel} from "./CountLabel.tsx";
import {BasePage} from "../IBasePage.ts";
import {emitEvent, listenEvent, type UnlistenFn} from "@/events";
import {AddModType} from "@/dialogs/AddModDialog";
import {SearchBox} from "@/pages/HomePage/SearchBox.tsx";
import {StorageAPI} from "@/storage";
import {cleanupRemovedRepositoryMod} from "@/services/RepositoryModCleanup";
import type {CompleteModData} from "@/storage/dao/ModDAO";
import type {ProfileData, ProfileModData} from "@/storage/dao/ProfileDAO";
import type {ProfileTreeItem} from "@/models/profile/ProfileTreeItem";
import {ModSourceType} from "@/models/mod/types";
import {MODCAT_PLATFORM} from "@/apis/modcat";
import {NEXUSMODS_PLATFORM} from "@/apis/nexusmods";
import {TreeView} from "./TreeView.tsx";
import {AppInitializer} from "@/core/AppInitializer";
import {IoC} from "@/core/IoC.ts";
import { taskQueueAPI } from "tauri-plugin-task-queue";
import type {DataNode} from "antd/es/tree";
import {
    clearPendingEnabled,
    clearPendingUsedVersion,
    clearPendingVersionLocked,
    clearCachedWarningState,
    clearCachedDownloadProgress,
} from "./TreeViewItem.tsx";
import { computeInstallManifestHash } from "@/tasks/InstallManifestHash";
import { flattenTreeModIds, sortByDisplayOrder } from "@/utils/ModDisplayOrder";
import { InstallOrder, ListDisplayOptions } from "@/services/ListDisplay";
import { rememberOpen, restoreOpen } from "./FolderOpenState";
import { RepositoryUpdates } from "@/services/RepositoryUpdates";
import { logActivity } from "@/services/ActivityLog";
import { RepositoryLinkDialog } from "@/dialogs/RepositoryLinkDialog";
import { UpdateReviewDialog } from "@/dialogs/UpdateReviewDialog";
import { defaultSaveLocation } from "@/utils/SaveLocation";
import type { UpdateReview } from "@/services/RepositoryUpdates";
import { openMintImport } from "@/dialogs/MintImportDialog";
import { ModDescriptions } from "@/services/ModDescriptions";
import { ConflictService } from "@/services/ConflictService";
import { ConflictReport } from "@/components/ConflictDetails";
import { getInternalAssetPaths, type InternalAssetGame } from "@/services/InternalAssetService";
import { isUe4ssEnabled } from "@/utils/Ue4ssSetting";
import { perfMark, perfUntilPainted } from "@/utils/perfTrace";
import { fileNameOf, findMovedSiblings, localModPath, parentDir, relocateLocalMod } from "@/services/LocalModRelocation";


interface ModListPageState {
    profileOptions?: SelectProps['options'];
    treeData?: TreeProps['treeData'];
    contextMenus?: MenuProps['items'];
    isMultiSelect?: boolean;
    /** Multi-select was started with Ctrl/Shift-click or Ctrl+A (a plain click ends it) */
    autoMultiSelect?: boolean;
    expandedKeys?: any[];
    selectedKeys?: any[];
    checkedKeys?: any[];
    defaultProfile?: string;
    displayMode?: string;
    loading?: boolean;
    virtual?: boolean;
    enableCount?: number;
    totalCount?: number;
    sortOrder?: string;
    hasUnsavedChanges?: boolean;
    /** Local mod being linked to a repository post (Link to Pak Hub post…) */
    repoLinkMod?: CompleteModData | null;
    /** Repository updates waiting for the user to pick what to replace */
    updateReviews?: UpdateReview[] | null;
}


/** Everything the list is built from; equal strings mean the same rows */
function treeSignature(profileId: number | undefined, root: ProfileTreeItem, profileMods: ProfileModData[], mods: CompleteModData[]): string {
    try {
        // The search box's filter changes what the list shows, so it is part of the signature too
        return JSON.stringify([i18next.language, profileId, TreeViewConverter.filterList ?? [], root, profileMods, mods]);
    } catch {
        return String(Math.random());
    }
}

export class HomePage extends BasePage<any, ModListPageState> {
    private lastFocusRecheck = 0;
    /** Inputs of the last list build; an identical reload skips re-rendering ~200 rows */
    private lastTreeSignature = "";
    private unlistenFocusRecheck?: () => void;

    private readonly profileEditDialogRef: React.RefObject<ProfileEditDialog> = React.createRef();

    private readonly inputDialogRef: React.RefObject<InputDialog> = React.createRef();

    // Event listener cleanup functions
    private unlistenActiveGameChange?: UnlistenFn;
    private unlistenConfigImported?: UnlistenFn;
    private unlistenModEnabledChange?: UnlistenFn;
    private unlistenModsInstalled?: UnlistenFn;
    private unlistenBatchDownloadComplete?: UnlistenFn;
    private unlistenModsAdded?: UnlistenFn;

    public constructor(props: any) {
        super(props);

        this.state = {
            profileOptions: [],
            contextMenus: [],
            expandedKeys: [],
            selectedKeys: [],
            checkedKeys: [],
            defaultProfile: "",
            loading: false,
            virtual: true,
            enableCount: 0,
            totalCount: 0,
            sortOrder: "name_asc",
            hasUnsavedChanges: false,
        }

    }

    /**
     * Compare the current manifest hash against both:
     * 1. the active profile's last successful install hash
     * 2. the active game's currently installed hash
     * This keeps the "unsaved" state correct after switching profiles.
     */
    private async refreshUnsavedState(): Promise<void> {
        try {
            const profileVM = await IoC.get(ProfileViewModel);
            const savedHash = await profileVM.getActiveProfileInstallHash();
            const installedHash = await profileVM.getActiveGameInstalledHash();

            const profilesDAO = await StorageAPI.getProfiles();
            const activeProfile = await profileVM.getActiveProfileData();
            const profileMods = await profilesDAO.getProfileMods(activeProfile.id!);
            // Same order as ModInstallTask so the hash matches after install
            const displayOrder = flattenTreeModIds(await profileVM.getActiveProfileTreeRoot());
            const enabledProfileMods = sortByDisplayOrder(
                profileMods.filter(pm => pm.isEnabled),
                displayOrder,
                pm => pm.modId
            );

            const modsDAO = await StorageAPI.getMods();
            // One batch query instead of four per mod: this runs after every change to the list
            const loaded = await modsDAO.getBatchCompleteModDataOptimized(enabledProfileMods.map(pm => pm.modId));
            const byId = new Map(loaded.map(m => [m.modId, m]));
            const enabledMods: CompleteModData[] = [];
            for (const pm of enabledProfileMods) {
                const modData = byId.get(pm.modId);
                if (modData) enabledMods.push(modData);
            }

            const settings = await StorageAPI.getSettings();
            const ue4ssEnabled = isUe4ssEnabled(await settings.getValue('ue4ss'));
            const compressModPak = await settings.getIntegratorCompressModPak();

            const gamesDAO = await StorageAPI.getGames();
            const activeGame = await gamesDAO.getActiveGame();
            const isRc = activeGame?.name?.toLowerCase() === 'rc';
            const assetPaths = await getInternalAssetPaths(isRc ? 'rc' : 'drg', ue4ssEnabled);

            const currentHash = await computeInstallManifestHash(
                enabledMods,
                ue4ssEnabled,
                compressModPak,
                assetPaths
            );
            const hasUnsaved = !savedHash || currentHash !== savedHash || currentHash !== installedHash;
            if (this.state.hasUnsavedChanges !== hasUnsaved) {
                this.setState({ hasUnsavedChanges: hasUnsaved });
            }
        } catch (e) {
            console.warn('[HomePage] refreshUnsavedState failed', e);
        }
    }

    /**
     * Helper method to extract modId from tree node key
     * Keys can be in format "mod-123" or just a number
     */
    private extractModIdFromKey(key: string | number): number | null {
        if (typeof key === 'number') {
            return key;
        }
        if (typeof key === 'string' && key.startsWith('mod-')) {
            const id = parseInt(key.substring(4));
            return isNaN(id) ? null : id;
        }
        const id = parseInt(String(key));
        return isNaN(id) ? null : id;
    }

    /**
     * Helper method to get a mod from database by ID
     */
    private async getModById(modId: number): Promise<CompleteModData | null> {
        const modsApi = await StorageAPI.getMods();
        return await modsApi.getCompleteModData(modId);
    }

    /**
     * Open folders by their path of names ("Parent/Child"): saving the list gives folders new ids.
     * A folder being renamed counts under its new name.
     */
    private getExpandedFolderNames(): string[] {
        return rememberOpen(this.state.treeData as DataNode[] | undefined, this.state.expandedKeys ?? [], this.pendingFolderRename);
    }

    /** Keys of the remembered open folders in a rebuilt list */
    private reconstructExpandedKeys(folderPaths: string[], treeData: DataNode[]): string[] {
        return restoreOpen(treeData, folderPaths);
    }

    private async handleExportMod(id: number): Promise<void> {
        try {
            const mod = await this.getModById(id);
            if (!mod) {
                message.error(t("Mod Not Found"));
                return;
            }

            const cachePath = mod.download?.cachePath || "";
            const downloadStatus = mod.download?.downloadStatus || "pending";

            if (!cachePath || downloadStatus !== "completed") {
                if (downloadStatus === "downloading") {
                    message.warning(t("mod.downloadingPleaseWait"));
                } else if (downloadStatus === "failed") {
                    message.error(t("mod.downloadFailedClickUpdateAgain"));
                } else {
                    message.warning(t("mod.pleaseClickUpdateToDownload"));
                }
                return;
            }

            const fileExists = await exists(cachePath);
            if (!fileExists) {
                message.error(t("File Not Found") + `: ${cachePath}`);
                return;
            }

            const path = await save({
                defaultPath: await defaultSaveLocation(cachePath.split(/[\\/]/).pop() || mod.displayName),
                filters: [{
                    name: mod.displayName,
                    extensions: ['zip', 'pak'],
                }]
            });

            if (!path) {
                return;
            }

            await copyFile(cachePath, path);
            message.success(t("Export Success"));
        } catch (e) {
            console.error(`[HomePage] Export failed for id=${id}:`, e);
            message.error(t("Export Failed") + `: ${e}`);
        }
    }

    private async handleCopyLink(id: number): Promise<void> {
        try {
            const mod = await this.getModById(id);
            if (mod?.url) {
                await ClipboardApi.writeText(mod.url);
                message.success(t("Copied To Clipboard") + `: ${mod.url} `);
            } else {
                const cachePath = mod?.download?.cachePath || "";
                await ClipboardApi.writeText(cachePath);
                message.success(t("Copied To Clipboard") + `: ${cachePath} `);
            }
        } catch (err) {
            console.error(`[HomePage] Copy link failed for id=${id}:`, err);
            message.error(t("Copy Failed"));
        }
    }

    /**
     * 从 treeData 中递归收集所有叶子节点（mod）的 key
     */
    private getAllLeafKeys(nodes: DataNode[] | undefined): string[] {
        if (!nodes || !Array.isArray(nodes)) return [];
        const keys: string[] = [];
        for (const node of nodes) {
            if (node.isLeaf) {
                keys.push(String(node.key));
            }
            if (node.children?.length) {
                keys.push(...this.getAllLeafKeys(node.children as DataNode[]));
            }
        }
        return keys;
    }

    /**
     * 多选时用勾选列表，否则用高亮列表（兼容）. Only mods the list shows right now: a mod picked
     * before the search filter hid it is left out, so bulk actions never touch mods you can't see.
     */
    private getBulkOpKeys(): string[] {
        const keys = this.state.isMultiSelect ? (this.state.checkedKeys || []) : (this.state.selectedKeys || []);
        const shown = new Set(this.getAllLeafKeys(this.state.treeData as DataNode[] | undefined));
        return keys.map(String).filter(k => !k.startsWith("mod-") || shown.has(k));
    }

    private isAllSelected(): boolean {
        const treeData = this.state.treeData as DataNode[] | undefined;
        const allKeys = this.getAllLeafKeys(treeData);
        if (allKeys.length === 0) return false;
        const checkedSet = new Set(this.getBulkOpKeys());
        return allKeys.every(key => checkedSet.has(key));
    }

    @autoBind
    private onMultiSelectAllClick() {
        const treeData = this.state.treeData as DataNode[] | undefined;
        const allKeys = this.getAllLeafKeys(treeData);
        const isAllSelected = this.isAllSelected();
        this.setState({ checkedKeys: isAllSelected ? [] : allKeys });
    }

    // Multi Operations
    @autoBind
    private onMultiCheckboxChange(e: checkbox.CheckboxChangeEvent) {
        const enabled = e.target.checked;
        this.setState((state) => ({
            isMultiSelect: enabled,
            autoMultiSelect: false,
            checkedKeys: enabled ? (state.selectedKeys?.length ? [...state.selectedKeys] : []) : [],
        }));
    }

    @autoBind
    private async onMultiDeleteClick() {
        const vm = await IoC.get(HomeViewModel);

        if (this.getBulkOpKeys().length === 0) {
            return;
        }

        const confirm = await MessageBox.confirm({
            title: t("Delete Mods"),
            content: t("dialog.confirmDeleteSelectedMods"),
        });

        if (confirm) {
            for (const key of this.getBulkOpKeys()) {
                const modId = this.extractModIdFromKey(key);
                if (modId === null) continue;
                const modItem = await this.getModById(modId);
                if (modItem) {
                    await vm.removeMod(modItem.modId!);
                }
            }
            this.setState((state) => ({
                checkedKeys: [],
                ...(state.autoMultiSelect ? { isMultiSelect: false, autoMultiSelect: false } : {}),
            }));
            await this.updateTreeView();
            await this.updateCountLabel();
        }
    }

    @autoBind
    private async onMultiEnableClick(isEnable: boolean) {
        const vm = await IoC.get(HomeViewModel);
        if (this.getBulkOpKeys().length === 0) {
            return;
        }

        const modIds: number[] = [];
        for (const key of this.getBulkOpKeys()) {
            const modId = this.extractModIdFromKey(key);
            if (modId === null) continue;
            modIds.push(modId);
        }

        // 单条 SQL 批量更新，避免逐条调用导致连接池争抢
        await vm.batchSetModEnabled(modIds, isEnable);

        // 单次批量事件通知所有 Switch 组件更新状态
        await emitEvent("mod-batch-enabled-change", { modIds, enabled: isEnable });

        clearPendingEnabled();
        await this.updateTreeView();
        await this.updateCountLabel();
        this.refreshUnsavedState();
    }

    @autoBind
    private async onMultiUpdateClick() {
        const mods: CompleteModData[] = [];

        for (const key of this.getBulkOpKeys()) {
            const modId = this.extractModIdFromKey(key);
            if (modId === null) continue;
            const modItem = await this.getModById(modId);
            if (modItem) {
                mods.push(modItem);
            }
        }

        if (mods.length > 0) {
            // 内部会先批量刷新元数据再下载
            const { successCount, errors } = await ModUpdateService.batchDownloadModFiles(mods, 3);
            if (errors.length > 0) {
                const failedNames = errors.map(e => e.mod.displayName).slice(0, 3).join(', ');
                const suffix = errors.length > 3
                    ? t("Batch Download More Errors", { count: errors.length - 3 })
                    : '';
                const firstReason = errors[0]?.error?.message;
                const reasonHint = firstReason ? ` — ${firstReason}` : '';
                message.error(`${t("Download Failed")}: ${failedNames}${suffix}${reasonHint}`);
            } else if (successCount > 0) {
                message.success(t("Update Finish With Count", { count: successCount }));
            }
        }
    }

    @autoBind
    private async onMultiCopyClick() {
        if (this.getBulkOpKeys().length === 0) {
            return;
        }

        const urls: string[] = [];
        for (const key of this.getBulkOpKeys()) {
            const modId = this.extractModIdFromKey(key);
            if (modId === null) continue;
            const mod = await this.getModById(modId);
            if (mod?.url) {
                urls.push(mod.url);
            }
        }

        if (urls.length > 0) {
            const text = urls.join("\n");
            await ClipboardApi.writeText(text);
            message.success(t("Copied URL Count", { count: urls.length }));
        }
    }

    // Menu Bar Operations
    @autoBind
    private async onMenuBarCopyListClick() {
        const vm = await IoC.get(HomeViewModel);
        await vm.exportModioUrlsToClipboard();
    }

    @autoBind
    private async onMenuBarAddModClick() {
        openWindow(AddModType.LOCAL, 0, "").then();
    }

    @autoBind
    private async onMenuBarSaveChangesClick() {
        try {
            // Submit installation task
            const taskId = await IntegrateApi.installMods();

            // Wait for task to complete (no timeout)
            const result = await taskQueueAPI.waitForTaskCompletion(taskId);

            if (result.status === 'completed') {
                this.refreshUnsavedState();
                message.success(t("Installation Finish"));
            } else if (result.status === 'failed') {
                const baseError = t("Installation Failed");
                const detail = result.error || 'Unknown error';
                const msg = detail.startsWith(baseError) ? detail : `${baseError}: ${detail}`;
                if (detail.includes(t('Game Path Not Found'))) {
                    await emitEvent('install-failed-game-path-not-found', msg);
                } else {
                    message.error(msg);
                }
            }
        } catch (error) {
            console.error('[HomePage] Installation failed:', error);
            message.error(t("Installation Failed"));
        }
    }

    @autoBind
    private async onMenuBarUpdateClick() {
        await ModUpdateService.checkModUpdate();
        await ModUpdateService.checkModList((loading) => {
            this.setState({ loading });
        });
        // 刷新所有在线 mod 的元数据（tags、approval、versions 等）
        const profilesApi = await StorageAPI.getProfiles();
        const activeProfile = await profilesApi.getActiveProfile();
        const profileMods = activeProfile ? await profilesApi.getProfileMods(activeProfile.id!) : [];
        const profileModIds = profileMods.map(pm => pm.modId!).filter(id => id != null);
        const modsApi = await StorageAPI.getMods();
        const scopedMods = profileModIds.length > 0
            ? await modsApi.getBatchCompleteModDataOptimized(profileModIds)
            : [];
        const onlineMods = scopedMods.filter(
            m => m.sourceType === ModSourceType.Modio || m.sourceType === MODCAT_PLATFORM || m.sourceType === "modcat" || m.sourceType === NEXUSMODS_PLATFORM
        );
        if (onlineMods.length > 0) {
            await ModUpdateService.refreshOnlineMetadata(onlineMods, 3);
        }
        // Local mods that come from a Pak Hub style repository
        try {
            const repoResult = await RepositoryUpdates.checkAll(scopedMods);
            if (repoResult.reviews.length > 0 || repoResult.linked > 0) {
                await logActivity('info', t("repoUpdate.reviewSummary", {found: repoResult.reviews.length, linked: repoResult.linked}), undefined, 'repository');
            }
            // Nothing is replaced without asking: show what was found
            if (repoResult.reviews.length > 0) this.setState({updateReviews: repoResult.reviews});
        } catch (e) {
            console.warn('[HomePage] repository update check failed', e);
        }
        await this.updateTreeView();
        await this.updateCountLabel();
        message.success(t("Update Finish"));
    }

    @autoBind
    private async onMenuBarCleanMissingLocalModsClick() {
        const confirm = await MessageBox.confirm({
            title: t("Clean Missing Local Mods"),
            content: t("dialog.confirmCleanMissingLocalMods"),
        });

        if (!confirm) {
            return;
        }

        const vm = await IoC.get(HomeViewModel);
        const cleanedCount = await vm.cleanMissingLocalMods();
        
        if (cleanedCount > 0) {
            await this.updateTreeView();
            await this.updateCountLabel();
            message.success(`${t("Clean Complete")}: ${cleanedCount} ${t("mods removed")}`);
        } else {
            message.info(t("clean.noMissingLocalModsFound"));
        }
    }

    @autoBind
    private async onMenuBarCheckConflictsClick() {
        let taskId: string;
        try {
            taskId = await taskQueueAPI.addTask({
                taskType: 'mod_conflict_check',
                params: {},
            });
        } catch (e) {
            console.error('error.startConflictCheck task:', e);
            message.error(t("error.startConflictCheck"));
            return;
        }

        // Show which mods clash, on which files, and which one wins
        try {
            const result = await taskQueueAPI.waitForTaskCompletion(taskId);
            if (result.status !== 'completed') {
                return;
            }
            if (ConflictService.getAllConflicts().length === 0) {
                message.success(t("No conflicts detected"));
                return;
            }
            this.showConflictReport();
        } catch (e) {
            console.warn('[HomePage] Conflict check result unavailable', e);
        }
    }

    @autoBind
    private showConflictReport() {
        MessageBox.info({
            title: t("conflict.reportTitle"),
            icon: null,
            width: 680,
            maskClosable: true,
            content: React.createElement(ConflictReport),
        });
    }

    @autoBind
    private async onMenuBarUninstallModsClick() {
        try {
            const confirm = await MessageBox.confirm({
                title: t("Uninstall Mods From Game"),
                content: t(
                    "dialog.confirmUninstallModsFromGame",
                ),
            });
            if (!confirm) {
                return;
            }
            await IntegrateApi.uninstallMods();
        } catch (error) {
            console.error('[HomePage] Uninstall mods failed:', error);
            message.error(t("Uninstall Failed"));
        }
    }

    @autoBind
    private async onMenuBarSortClick(order: string) {
        this.setState({ sortOrder: order });
        const vm = await IoC.get(TreeViewModel);
        await vm.sortMods(order);
        await this.updateTreeView();
    }

    @autoBind
    private async onSortMenuClick({ key }: { key: string }) {
        await this.onMenuBarSortClick(key);
    }

    @autoBind
    private onEditProfileClick() {
        this.profileEditDialogRef
            .current?.setCallback(async () => {
            await this.updateProfileSelect();
            await this.updateTreeView();
            await this.updateCountLabel();
        }).show();
    }

    @autoBind
    private async onSelectChange(value: string) {
        // 立即更新 UI 状态，让用户感知到切换
        this.setState({
            defaultProfile: value as string,
            loading: true,
        });

        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);

        // 设置活跃 profile（已优化为 2 次 SQL）
        await profileVM.setActiveProfile(value);
        
        // 清除 mod 相关缓存，确保新 profile 使用自己的状态
        clearPendingEnabled();
        clearPendingUsedVersion();
        clearPendingVersionLocked();
        clearCachedWarningState();
        clearCachedDownloadProgress();
        
        // 后台执行在线更新检查，不阻塞 UI
        ModUpdateService.checkModUpdate().catch(err => {
            console.warn('[HomePage] Background mod update check failed:', err);
        });
        
        // 一次性加载所有数据，复用于后续操作
        // resetExpandedKeys=true: 切换 profile 时使用新 profile 的默认展开状态
        await this.loadProfileDataOptimized(true);
    };

    /**
     * 优化后的 profile 数据加载
     * 合并多个查询，避免重复获取数据
     * @param resetExpandedKeys 是否重置展开状态（切换 profile 时为 true）
     */
    @autoBind
    private async loadProfileDataOptimized(resetExpandedKeys: boolean = false) {
        const profileVM = await IoC.get(ProfileViewModel);
        const modsApi = await StorageAPI.getMods();
        const profilesApi = await StorageAPI.getProfiles();

        // 并行获取所有需要的数据
        const [allMods, activeRoot, activeProfile] = await Promise.all([
            modsApi.getAllCompleteModData(),  // 优化：一次查询获取所有完整数据
            profileVM.getActiveProfileTreeRoot(),
            profilesApi.getActiveProfile(),
        ]);

        // 获取 profile mods（需要 activeProfile.id）
        const profileMods = activeProfile ? await profilesApi.getProfileMods(activeProfile.id!) : [];

        // 使用预加载的数据检查本地缓存（不再重复查询）
        await ModUpdateService.checkModListWithData(allMods, (loading) => {
            this.setState({ loading });
        });

        // 使用预加载的数据更新树视图
        await this.updateTreeViewWithData(allMods, activeRoot, activeProfile, profileMods, resetExpandedKeys);

        // 更新计数（使用已有的 profileMods）
        this.setState({
            enableCount: profileMods.filter(mod => mod.isEnabled).length,
            totalCount: profileMods.length,
            loading: false,
        });
        await this.refreshUnsavedState();
    }

    /**
     * 使用预加载数据更新树视图
     * @param resetExpandedKeys 是否重置展开状态（切换 profile 时为 true，使用新 profile 的默认展开状态）
     */
    @autoBind
    private async updateTreeViewWithData(
        allMods: CompleteModData[],
        activeRoot: ProfileTreeItem,
        activeProfile: ProfileData | null,
        profileMods: ProfileModData[],
        resetExpandedKeys: boolean = false
    ) {
        this.lastTreeSignature = "";
        // TreeViewConverter now accepts CompleteModData[] and ProfileModData[]
        const converter = new TreeViewConverter(allMods, profileMods);
        converter.convertToFromRoot(activeRoot);
        void ModListAppearance.migrateLegacyKeys(TreeViewConverter.folderColorKeys);
        // Global install positions (folders included) for the row badges and conflict winners
        InstallOrder.set(flattenTreeModIds(activeRoot));

        const newExpandedKeys = this.nextExpandedKeys(converter.treeData as DataNode[], converter.expandedKeys ?? [], resetExpandedKeys);

        this.setState({
            treeData: converter.treeData,
            expandedKeys: newExpandedKeys,
        });
    }

    /** 仅更新高亮选中（点击行时），避免与 onCheck 混用导致焦点跳到第一项 */
    /** Mod rows in the order shown, skipping mods inside collapsed folders */
    private getVisibleModKeys(nodes: DataNode[] | undefined = this.state.treeData as DataNode[] | undefined): string[] {
        const expanded = new Set((this.state.expandedKeys ?? []).map(String));
        const keys: string[] = [];
        const walk = (list: DataNode[] | undefined) => {
            for (const node of list ?? []) {
                if (node.isLeaf) keys.push(String(node.key));
                else if (expanded.has(String(node.key))) walk(node.children as DataNode[]);
            }
        };
        walk(nodes);
        return keys;
    }

    /** The folder's name and how many mods it and its subfolders hold in the active profile */
    private async countModsInFolder(folderId: number): Promise<{ name: string; mods: number; modIds: number[] }> {
        try {
            const profiles = await StorageAPI.getProfiles();
            const profile = await profiles.getActiveProfile();
            const [folders, mods] = await Promise.all([
                profiles.getProfileFolders(profile.id!),
                profiles.getProfileMods(profile.id!),
            ]);
            const inside = new Set<number>([folderId]);
            let grew = true;
            while (grew) {
                grew = false;
                for (const folder of folders) {
                    if (folder.id != null && folder.parentFolderId != null
                        && inside.has(folder.parentFolderId) && !inside.has(folder.id)) {
                        inside.add(folder.id);
                        grew = true;
                    }
                }
            }
            const modIds = mods
                .filter(m => m.parentFolderId != null && inside.has(m.parentFolderId))
                .map(m => m.modId);
            return {name: folders.find(f => f.id === folderId)?.name ?? "", mods: modIds.length, modIds};
        } catch (error) {
            console.warn("[HomePage] could not count the folder's mods", error);
            // unknown: ask anyway
            return {name: "", mods: 1, modIds: []};
        }
    }

    private selectionAnchor?: string;
    /** A folder being renamed: its open state is looked up under the new name */
    private pendingFolderRename?: { key: string; name: string };

    /**
     * Click: select one row. Ctrl-click: add/remove a mod (or all mods of a folder) from the
     * selection. Shift-click: select the mods between the last clicked one and this one. A
     * selection of several mods shows the bulk bar (enable, disable, move, delete, …).
     */
    @autoBind
    private onTreeNodeSelect(keys: any[], info?: any) {
        const ev = info?.nativeEvent as MouseEvent | undefined;
        const node = info?.node;
        const key = node ? String(node.key) : undefined;
        const additive = !!ev && (ev.ctrlKey || ev.metaKey);
        if (key && ev && (additive || ev.shiftKey)) {
            const current = new Set<string>(this.state.isMultiSelect
                ? (this.state.checkedKeys ?? []).map(String)
                : (this.state.selectedKeys ?? []).map(String).filter(k => k.startsWith("mod-")));
            let next: Set<string>;
            if (!node.isLeaf) {
                const inFolder = this.getAllLeafKeys([node] as DataNode[]).map(String);
                const allIn = inFolder.length > 0 && inFolder.every(k => current.has(k));
                next = new Set(current);
                inFolder.forEach(k => (allIn ? next.delete(k) : next.add(k)));
            } else if (ev.shiftKey && this.selectionAnchor) {
                const visible = this.getVisibleModKeys();
                const from = visible.indexOf(this.selectionAnchor);
                const to = visible.indexOf(key);
                const range = from >= 0 && to >= 0
                    ? visible.slice(Math.min(from, to), Math.max(from, to) + 1)
                    : [key];
                next = additive ? new Set([...current, ...range]) : new Set(range);
            } else {
                next = new Set(current);
                if (next.has(key)) next.delete(key); else next.add(key);
                this.selectionAnchor = key;
            }
            if (node.isLeaf && !ev.shiftKey) this.selectionAnchor = key;
            this.setState((state) => ({
                isMultiSelect: true,
                autoMultiSelect: state.isMultiSelect ? state.autoMultiSelect : true,
                checkedKeys: [...next],
                // a mod Ctrl-clicked out of the selection doesn't stay highlighted
                selectedKeys: node.isLeaf ? (next.has(key) ? [key] : []) : state.selectedKeys,
            }));
            return;
        }
        if (key && node?.isLeaf) this.selectionAnchor = key;
        if (this.state.autoMultiSelect) {
            this.setState({ isMultiSelect: false, autoMultiSelect: false, checkedKeys: [], selectedKeys: keys ?? [] });
            return;
        }
        this.setState({ selectedKeys: keys ?? [] });
    }

    /** Mod rows keep plain clicks to themselves; Ctrl/Shift-clicks go to the selection */
    @autoBind
    private onTreeRowClick(nodeKey: string, e: React.MouseEvent) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            this.onTreeNodeSelect([nodeKey], { node: { key: nodeKey, isLeaf: true }, nativeEvent: e.nativeEvent });
            return;
        }
        // A plain click selects this row (the row background stops the tree's own click, so
        // the tree never sees it); a selection of several made with Ctrl/Shift ends
        this.selectionAnchor = nodeKey;
        this.setState((state) => ({
            selectedKeys: [nodeKey],
            ...(state.autoMultiSelect ? { isMultiSelect: false, autoMultiSelect: false, checkedKeys: [] } : {}),
        }));
    }

    /** Folders for the bulk "Move to" menu, with their parents ("Cosmetics / Custom Icons") */
    private getFolderChoices(): { key: string; label: string }[] {
        const out: { key: string; label: string }[] = [];
        const walk = (list: DataNode[] | undefined, path: string[]) => {
            for (const node of list ?? []) {
                if (node.isLeaf) continue;
                const name = String((node as any).title ?? "");
                out.push({ key: String(node.key), label: [...path, name].join(" / ") });
                walk(node.children as DataNode[], [...path, name]);
            }
        };
        walk(this.state.treeData as DataNode[] | undefined, []);
        return out;
    }

    /** Move the selected mods to the top of a folder, keeping their order (like moving one mod) */
    @autoBind
    private async onMultiMoveClick(targetFolderKey: string) {
        const selected = new Set(this.getBulkOpKeys().map(String).filter(k => k.startsWith("mod-")));
        if (selected.size === 0) return;
        try {
            await IoC.get(TreeViewModel);
            const profileVM = await IoC.get(ProfileViewModel);
            const activeRoot = await profileVM.getActiveProfileTreeRoot();
            const modsApi = await StorageAPI.getMods();
            const basic = await modsApi.getAllMods();
            const allMods = await modsApi.getBatchCompleteModDataOptimized(basic.map(m => m.modId!));
            const converter = new TreeViewConverter(allMods);
            // Work on the whole list, not only what the search shows
            const filterList = TreeViewConverter.filterList;
            TreeViewConverter.filterList = [];
            const full = (converter.convertToFromRoot(activeRoot) ?? []) as any[];
            TreeViewConverter.filterList = filterList;

            const picked: any[] = [];
            const strip = (list: any[]): any[] => list.filter(node => {
                if (selected.has(String(node.key))) {
                    picked.push(node);
                    return false;
                }
                if (node.children) node.children = strip(node.children);
                return true;
            });
            const rest = strip(full);
            const findFolder = (list: any[]): any | undefined => {
                for (const node of list) {
                    if (String(node.key) === targetFolderKey) return node;
                    const inner = node.children ? findFolder(node.children) : undefined;
                    if (inner) return inner;
                }
                return undefined;
            };
            const target = findFolder(rest);
            if (!target || picked.length === 0) return;
            target.children = [...picked, ...(target.children ?? [])];

            const profileTreeItem = converter.convertFrom(rest);
            if (!profileTreeItem || profileTreeItem.children.length === 0) return;
            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            const folderName = this.getFolderChoices().find(f => f.key === targetFolderKey)?.label ?? "";
            message.success(t("multi.moved", { count: picked.length, folder: folderName }));
            if (!(this.state.expandedKeys ?? []).map(String).includes(targetFolderKey)) {
                this.setState((state) => ({ expandedKeys: [...(state.expandedKeys ?? []), targetFolderKey] }));
            }
            await this.updateTreeView();
            this.refreshUnsavedState();
        } catch (error) {
            console.error("[HomePage] bulk move failed", error);
            message.error(t("multi.moveFailed", { reason: String(error) }));
        }
    }

    /** Ctrl+A selects every shown mod, Escape ends a Ctrl/Shift selection, Delete removes the selection */
    @autoBind
    private onListKeyDown(e: KeyboardEvent) {
        if (!this.props.active) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.closest("input, textarea, select, [contenteditable='true']"))) return;
        if (document.querySelector(".ant-modal-wrap:not([style*='display: none'])")) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            this.setState((state) => ({
                isMultiSelect: true,
                autoMultiSelect: state.isMultiSelect ? state.autoMultiSelect : true,
                checkedKeys: this.getAllLeafKeys(state.treeData as DataNode[]).map(String),
            }));
        } else if (e.key === "Escape" && this.state.autoMultiSelect) {
            this.setState({ isMultiSelect: false, autoMultiSelect: false, checkedKeys: [] });
        } else if (e.key === "Delete" && this.state.isMultiSelect && (this.state.checkedKeys ?? []).length > 0) {
            e.preventDefault();
            void this.onMultiDeleteClick();
        }
    }

    /** 仅更新勾选列表（点击复选框时），用于多选与批量操作 */
    @autoBind
    private onTreeNodeCheck(checkedKeys: any) {
        const keys = Array.isArray(checkedKeys) ? checkedKeys : (checkedKeys?.checked ?? []);
        this.setState({ checkedKeys: keys });
    }

    /** Names of the folders that were open before a search opened the ones with matches */
    private expandedBeforeSearch: string[] | null = null;

    /**
     * Which folders are open after the list is rebuilt. Folders are matched by name, as saving
     * the list gives them new ids. A search opens every folder with a matching mod (else the
     * matches could be hidden in closed folders) and clearing it puts the earlier ones back.
     */
    private nextExpandedKeys(treeData: DataNode[], defaults: any[], reset: boolean): any[] {
        if (reset) {
            // another profile or game: all open
            this.expandedBeforeSearch = null;
            return defaults;
        }
        const searching = (TreeViewConverter.filterList ?? []).some(f => f && f !== "All");
        if (searching) {
            if (this.expandedBeforeSearch === null) this.expandedBeforeSearch = this.getExpandedFolderNames();
            const keys = new Set(this.reconstructExpandedKeys(this.getExpandedFolderNames(), treeData));
            const withMods = (nodes: DataNode[] | undefined): boolean => {
                let any = false;
                for (const node of nodes ?? []) {
                    if (node.isLeaf) {
                        any = true;
                    } else if (withMods(node.children as DataNode[] | undefined)) {
                        keys.add(String(node.key));
                        any = true;
                    }
                }
                return any;
            };
            withMods(treeData);
            return [...keys];
        }
        if (this.expandedBeforeSearch !== null) {
            const names = this.expandedBeforeSearch;
            this.expandedBeforeSearch = null;
            return this.reconstructExpandedKeys(names, treeData);
        }
        const expandedFolderNames = this.getExpandedFolderNames();
        if (expandedFolderNames.length > 0) {
            const reconstructedKeys = this.reconstructExpandedKeys(expandedFolderNames, treeData);
            // none of them is left (deleted or renamed elsewhere): all open
            return reconstructedKeys.length > 0 ? reconstructedKeys : defaults;
        }
        if (!this.state.treeData?.length) {
            // first load: all open
            return defaults;
        }
        // every folder was closed (e.g. "Collapse all folders"): keep them closed
        return [];
    }

    /** Keys of every folder in the list, subfolders included */
    private getAllFolderKeys(): string[] {
        const keys: string[] = [];
        const walk = (nodes: DataNode[] | undefined) => {
            for (const node of nodes ?? []) {
                if (!node.isLeaf && String(node.key).startsWith("folder-")) {
                    keys.push(String(node.key));
                    walk(node.children as DataNode[] | undefined);
                }
            }
        };
        walk(this.state.treeData as DataNode[] | undefined);
        return keys;
    }

    /** Whether every folder is open (false when there are no folders) */
    private allFoldersExpanded(): boolean {
        const folders = this.getAllFolderKeys();
        const open = new Set((this.state.expandedKeys ?? []).map(String));
        return folders.length > 0 && folders.every(k => open.has(k));
    }

    @autoBind
    private setAllFoldersExpanded(expand: boolean) {
        this.setState({expandedKeys: expand ? this.getAllFolderKeys() : []});
    }

    @autoBind
    private onTreeNodeExpand(keys) {
        this.setState({
            expandedKeys: keys,
        })
    };

    @autoBind
    private onTreeRightClick(info) {
        this.setState({
            selectedKeys: [info.node.key],
        })
    };

    @autoBind
    private async updateProfileSelect() {
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);

        const profileList = await profileVM.getProfileList();
        const activeProfileName = await profileVM.getActiveProfileName();

        const options: SelectProps['options'] = profileList.map(profileKey => ({
            value: profileKey,
            label: profileKey,
        }));
        this.setState({
            profileOptions: options,
            defaultProfile: activeProfileName,
        })
        await this.updateCountLabel();
    }

    /**
     * 更新树视图
     * @param resetExpandedKeys 是否重置展开状态（切换 profile/游戏时为 true）
     */
    @autoBind
    private async updateTreeView(resetExpandedKeys: boolean = false) {
        perfMark('home:tree-load');
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const modsApi = await StorageAPI.getMods();
        const profilesApi = await StorageAPI.getProfiles();

        // Get all mods with complete data (version, download, status)
        const basicMods = await modsApi.getAllMods();
        const modIds = basicMods.map(m => m.modId!);
        const allMods = await modsApi.getBatchCompleteModDataOptimized(modIds);

        // Get active profile tree root
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const activeProfile = await profilesApi.getActiveProfile();

        // Get profile-specific mod data (enabled status, used version)
        const profileMods = activeProfile ? await profilesApi.getProfileMods(activeProfile.id!) : [];

        // Nothing changed since the list was last built: keep the rendered rows as they are
        const signature = treeSignature(activeProfile?.id, activeRoot, profileMods, allMods);
        if (!resetExpandedKeys && signature === this.lastTreeSignature && this.state.treeData?.length) {
            perfMark('home:tree-unchanged');
            await this.refreshUnsavedState();
            return;
        }
        this.lastTreeSignature = signature;
        // Hover descriptions (when turned on): load the list's mod.io descriptions in a few requests
        const inProfile = new Set(profileMods.map(pm => pm.modId));
        ModDescriptions.prefetch(allMods
            .filter(m => inProfile.has(m.modId!))
            .map(m => ({modId: m.modId!, platformId: m.platformId, nameId: m.nameId, sourceType: m.sourceType, url: m.url})));
        // Link local mods to their repository (Pak Hub) posts in the background, by file name
        RepositoryUpdates.scheduleAutoLink(allMods.filter(m => inProfile.has(m.modId!)));

        // TreeViewConverter now accepts CompleteModData[] and ProfileModData[]
        const converter = new TreeViewConverter(allMods, profileMods);
        converter.convertToFromRoot(activeRoot);
        void ModListAppearance.migrateLegacyKeys(TreeViewConverter.folderColorKeys);
        // Global install positions (folders included) for the row badges and conflict winners
        InstallOrder.set(flattenTreeModIds(activeRoot));

        const newExpandedKeys = this.nextExpandedKeys(converter.treeData as DataNode[], converter.expandedKeys ?? [], resetExpandedKeys);

        this.setState({
            treeData: converter.treeData,
            expandedKeys: newExpandedKeys,
        }, () => perfUntilPainted('home:tree'));
        await this.refreshUnsavedState();
    }

    @autoBind
    private async updateCountLabel() {
        const profileVM = await IoC.get(ProfileViewModel);
        const activeProfile = await profileVM.getActiveProfileData();

        if (!activeProfile?.id) {
            this.setState({
                enableCount: 0,
                totalCount: 0,
            });
            return;
        }

        const profilesApi = await StorageAPI.getProfiles();
        const profileMods = await profilesApi.getProfileMods(activeProfile.id);

        this.setState({
            enableCount: profileMods.filter(mod => mod.isEnabled).length,
            totalCount: profileMods.length,
        });
    }

    /**
     * Let the user pick the new location of a local mod's file (moved or renamed on disk).
     * Other missing mods from the same old folder that are in the new folder are offered too.
     */
    private async relocateLocalMod(modId: number) {
        const mod = await this.getModById(modId);
        if (!mod || mod.sourceType !== ModSourceType.Local) return;
        const name = mod.displayName || fileNameOf(localModPath(mod));
        const oldPath = localModPath(mod);
        const oldDir = parentDir(oldPath);

        let startDir: string | undefined;
        try {
            if (oldDir && await exists(oldDir)) startDir = oldDir;
        } catch {
            // the old folder may be outside what we can check; just open the default folder
        }

        const picked = await openFileDialog({
            title: t("localMods.locateTitle", {name}),
            multiple: false,
            directory: false,
            defaultPath: startDir,
            filters: [{name: t("localMods.locateFilter"), extensions: ["pak", "zip"]}],
        });
        if (!picked || Array.isArray(picked)) return;

        const result = await relocateLocalMod(mod, picked);
        if (result.status === 'missing') {
            message.error(t("Mod Path No Exists") + ": " + picked);
            return;
        }
        if (result.status === 'inUse') {
            message.warning(t("localMods.locateInUse", {name: result.otherName}));
            return;
        }
        if (result.status !== 'ok') return;

        message.success(t("localMods.located", {name}));
        await logActivity('success', t("localMods.located", {name}), picked, 'files');

        // A moved folder usually takes several mods with it
        const siblings = await findMovedSiblings(oldDir, parentDir(picked), modId);
        if (siblings.length > 0) {
            const names = siblings.map(s => s.mod.displayName || fileNameOf(s.newPath));
            const ok = await MessageBox.confirm({
                title: t("localMods.siblingsTitle", {count: siblings.length}),
                content: (
                    <div>
                        <Typography.Paragraph>{t("localMods.siblingsBody", {folder: parentDir(picked)})}</Typography.Paragraph>
                        <ul style={{margin: 0, paddingLeft: 18, maxHeight: 200, overflowY: "auto"}}>
                            {names.map(n => <li key={n}>{n}</li>)}
                        </ul>
                    </div>
                ),
                okText: t("localMods.siblingsOk"),
                cancelText: t("Cancel"),
            });
            if (ok) {
                let moved = 0;
                for (const s of siblings) {
                    const r = await relocateLocalMod(s.mod, s.newPath);
                    if (r.status === 'ok') {
                        moved++;
                        await logActivity('success', t("localMods.located", {name: s.mod.displayName || fileNameOf(s.newPath)}), s.newPath, 'files');
                    }
                }
                if (moved > 0) message.success(t("localMods.siblingsDone", {count: moved}));
            }
        }

        await ModUpdateService.recheckLocalModFiles();
        await this.updateTreeView();
    }

    @autoBind
    private async onMenuClick(key: string, nodeKey: string) {
        const vm = await IoC.get(HomeViewModel);
        let shouldUpdateTree = false;
        let shouldUpdateCount = false;

        // Helper function to extract numeric ID from nodeKey (e.g., "folder-3" -> 3)
        const extractId = (key: string): number => {
            if (typeof key === 'string' && key.includes('-')) {
                const parts = key.split('-');
                return parseInt(parts[1], 10);
            }
            return parseInt(key as any, 10);
        };

        // Extract ID for tree nodes
        const id = extractId(nodeKey);

        switch (key) {
            case "expand_all_folders":
                this.setAllFoldersExpanded(true);
                break;
            case "collapse_all_folders":
                this.setAllFoldersExpanded(false);
                break;
            case "add_new_group": {
                this.inputDialogRef.current?.setCallback(
                    t("Add New Group"),
                    t("New Group"),
                    async (text) => {
                        await vm.addGroup(0, text);
                        await this.updateTreeView();
                    })
                    .show();
            }
                break;
            case "add_sub_group":
                this.inputDialogRef.current?.setCallback(
                    t("Add Sub Group"),
                    t("New Group"),
                    async (text) => {
                        await vm.addGroup(id, text);
                        await this.updateTreeView();
                    }).show();
                break;
            case "delete_group":
                try {
                    // Deleting a folder takes the mods in it (and in its subfolders) out of the
                    // profile; one click in the menu shouldn't do that without asking
                    const inside = await this.countModsInFolder(id);
                    if (inside.mods > 0) {
                        const ok = await MessageBox.confirm({
                            title: t("Delete Group"),
                            content: t("group.deleteConfirm", {name: inside.name, count: inside.mods}),
                            okText: t("group.deleteOk"),
                        });
                        if (!ok) break;
                    }
                    await vm.removeGroup(id);
                    // like removing the mods one by one: files MINTCAT downloaded for them go too
                    for (const modId of inside.modIds) {
                        await cleanupRemovedRepositoryMod(modId);
                    }
                    shouldUpdateTree = true;
                    // the enabled/total count at the bottom included the removed mods
                    shouldUpdateCount = inside.mods > 0;
                } catch (error) {
                    if (error instanceof LastGroupCannotDeleteError) {
                        message.warning(t("group.cannotDeleteLast"));
                    } else {
                        console.error(`[HomePage] Delete group failed for id=${id}:`, error);
                    }
                }
                break;
            case "rename_group":
                const groupName = await vm.getGroupName(id);
                this.inputDialogRef.current?.setCallback(
                    t("Rename Group"),
                    groupName || "",
                    async (text) => {
                        // the folder's color follows its new name
                        const oldColorKey = TreeViewConverter.folderColorKeys[`folder-${id}`];
                        await vm.setGroupName(id, text);
                        if (oldColorKey) {
                            const parent = oldColorKey.slice(0, Math.max(oldColorKey.lastIndexOf("/"), FOLDER_COLOR_PREFIX.length - 1) + 1);
                            const newColorKey = (parent.length > FOLDER_COLOR_PREFIX.length ? parent : FOLDER_COLOR_PREFIX) + text;
                            await ModListAppearance.renameFolderKey(oldColorKey, newColorKey);
                        }
                        this.pendingFolderRename = {key: `folder-${id}`, name: text};
                        try {
                            await this.updateTreeView();
                        } finally {
                            this.pendingFolderRename = undefined;
                        }
                    }).show();
                break;
            case "update": {
                const mod = await this.getModById(id);
                if (mod && mod.sourceType === ModSourceType.Local) {
                    // Local mods can be updated from the repository post they're linked to
                    try {
                        const hide = message.loading(t("repoUpdate.checking"), 0);
                        const outcome = await RepositoryUpdates.reviewOne(mod).finally(hide);
                        if (outcome === 'notLinked') message.info(t("repoUpdate.notLinked"));
                        else if (outcome === 'upToDate') message.success(t("repoUpdate.upToDate"));
                        else this.setState({updateReviews: [outcome]});
                    } catch (e) {
                        message.error(t("repoUpdate.failed", {name: mod.displayName, reason: String(e)}));
                    }
                } else if (mod) {
                    await ModUpdateService.updateMod(mod);
                }
            }
                break;
            case "repo_link": {
                const mod = await this.getModById(id);
                if (mod) this.setState({repoLinkMod: mod});
            }
                break;
            case "repo_unlink": {
                await RepositoryUpdates.removeLink(id);
                message.success(t("repoLink.unlinked"));
            }
                break;
            case "relocate":
                await this.relocateLocalMod(id);
                break;
            case "add_mod": {
                // id 就是 folder ID，直接使用
                await openWindow(AddModType.LOCAL, id, "");
            }
                break;
            case "rename":
                const mod = await this.getModById(id);
                const modName = mod?.displayName;
                this.inputDialogRef.current.setCallback(
                    "Rename Mod",
                    modName,
                    async (text) => {
                        await vm.setDisplayName(id, text);
                        await this.updateTreeView();
                    }).show();
                break;
            case "delete":
                await vm.removeMod(id);
                shouldUpdateTree = true;
                shouldUpdateCount = true;
                break;
            case "copy_link":
                await this.handleCopyLink(id);
                break;
            case "export": {
                await this.handleExportMod(id);
            }
                break;
            case "pin_to_top": {
                const activeProfile = await (await StorageAPI.getProfiles()).getActiveProfile();
                if (!activeProfile?.id) break;
                const profilesApi = await StorageAPI.getProfiles();
                const profileMod = await profilesApi.getProfileMod(activeProfile.id, id);
                if (!profileMod?.id) break;
                const allMods = await profilesApi.getProfileMods(activeProfile.id);
                const sameFolder = allMods.filter(
                    (m) => (m.parentFolderId ?? null) === (profileMod.parentFolderId ?? null)
                );
                sameFolder.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
                const idx = sameFolder.findIndex((m) => m.modId === id);
                if (idx <= 0) break;
                const reordered = [sameFolder[idx], ...sameFolder.slice(0, idx), ...sameFolder.slice(idx + 1)];
                for (let i = 0; i < reordered.length; i++) {
                    await profilesApi.updateProfileMod(reordered[i].id!, { sortOrder: i });
                }
                shouldUpdateTree = true;
            }
                break;
            default:
                break;
        }

        if (shouldUpdateTree) {
            await this.updateTreeView();
        }
        if (shouldUpdateCount) {
            await this.updateCountLabel();
        }
    }

    async componentDidMount(): Promise<void> {
        perfMark('home:mount');
        window.addEventListener("keydown", this.onListKeyDown);
        // Wait for core to be ready
        if (!AppInitializer.isCoreReady()) {
            await AppInitializer.initializeCore();
        }

        // Pre-initialize UI ViewModels (optional but recommended for better UX)
        await IoC.get(TreeViewModel);
        await IoC.get(HomeViewModel);

        // 清除 mod 相关缓存，确保使用当前 profile 的状态
        clearPendingEnabled();
        clearPendingUsedVersion();
        clearPendingVersionLocked();
        clearCachedWarningState();
        clearCachedDownloadProgress();

        // Setup window resize hook
        this.hookWindowResized();
        this.hookLogPanel();

        // Re-check local mod files when coming back to the window (they may have been moved/deleted)
        getCurrentWindow().onFocusChanged(({payload: focused}) => {
            const now = Date.now();
            if (focused && now - this.lastFocusRecheck > 5000) {
                this.lastFocusRecheck = now;
                ModUpdateService.recheckLocalModFiles()
                    .then(changed => (changed > 0 ? this.updateTreeView() : undefined))
                    .catch(e => console.warn('[HomePage] local file re-check failed', e));
            }
        }).then(unlisten => {
            this.unlistenFocusRecheck = unlisten;
        }).catch(() => undefined);

        // Setup event listeners
        // 监听单个 mod 启用/禁用切换事件
        this.unlistenModEnabledChange = await listenEvent("mod-enabled-change", () => {
            this.refreshUnsavedState();
        });

        // 监听 mod 安装完成事件（例如从标题栏启动游戏时触发的安装）
        this.unlistenModsInstalled = await listenEvent("mods-installed", () => {
            this.refreshUnsavedState();
        });

        // 监听批量下载完成，清除进度缓存并刷新树，避免虚拟列表下遗留 "0.00%" 标签
        this.unlistenBatchDownloadComplete = await listenEvent("batch-download-complete", async () => {
            clearCachedDownloadProgress();
            await this.updateTreeView();
        });

        // 监听 mod 列表变更（剪切板添加、SearchPage 添加等无直接回调的路径）
        this.unlistenModsAdded = await listenEvent("mods-added", async () => {
            await this.updateTreeView();
            await this.updateCountLabel();
        });

        // 监听游戏切换事件，切换时更新 TreeView 和 Profile 列表
        this.unlistenActiveGameChange = await listenEvent("active-game-change", async () => {
            // 清除 mod 相关缓存，确保新 profile 使用自己的状态
            clearPendingEnabled();
            clearPendingUsedVersion();
            clearPendingVersionLocked();
            clearCachedWarningState();
            clearCachedDownloadProgress();
            
            await this.updateProfileSelect();
            // 切换游戏时重置展开状态，使用新 profile 的默认展开状态
            await this.updateTreeView(true);
            await this.updateCountLabel();
        });

        // 监听配置导入成功，与游戏切换类似地刷新 Profile / TreeView / 计数
        this.unlistenConfigImported = await listenEvent("config-imported", async () => {
            clearPendingEnabled();
            clearPendingUsedVersion();
            clearPendingVersionLocked();
            clearCachedWarningState();
            clearCachedDownloadProgress();
            await this.updateProfileSelect();
            await this.updateTreeView(true);
            await this.updateCountLabel();
        });

        // Initial UI update
        this.updateProfileSelect().then();
        this.updateTreeView().then();
        this.updateCountLabel().then();

        // Check for mod updates
        ModUpdateService.checkModList((loading) => {
            this.setState({ loading });
        }).then((changed) => {
            // The list may have loaded before this check finished; show its results
            if (changed > 0) {
                this.updateTreeView().catch(e => console.warn('[HomePage] refresh after file check failed', e));
            }
        });
    }

    componentDidUpdate(prevProps: Readonly<any>): void {
        // Shown again after another page (the list stays mounted while hidden)
        if (this.props.active && prevProps.active === false) {
            perfUntilPainted('home:shown');
            // Pick up anything changed elsewhere; skipped cheaply when nothing did
            this.updateTreeView().catch(e => console.warn('[HomePage] refresh on show failed', e));
            const now = Date.now();
            if (now - this.lastFocusRecheck > 5000) {
                this.lastFocusRecheck = now;
                ModUpdateService.recheckLocalModFiles()
                    .then(changed => (changed > 0 ? this.updateTreeView() : undefined))
                    .catch(e => console.warn('[HomePage] local file re-check failed', e));
            }
        }
    }

    componentWillUnmount(): void {
        window.removeEventListener("keydown", this.onListKeyDown);
        this.unhookLogPanel();
        this.unhookWindowResized();
        this.unlistenFocusRecheck?.();
        // ✅ 清理所有事件监听器
        if (this.unlistenActiveGameChange) {
            this.unlistenActiveGameChange();
        }
        if (this.unlistenConfigImported) {
            this.unlistenConfigImported();
        }
        if (this.unlistenModEnabledChange) {
            this.unlistenModEnabledChange();
        }
        if (this.unlistenModsInstalled) {
            this.unlistenModsInstalled();
        }
        if (this.unlistenBatchDownloadComplete) {
            this.unlistenBatchDownloadComplete();
        }
        if (this.unlistenModsAdded) {
            this.unlistenModsAdded();
        }
    }

    render() {
        return (
            <div className="mod-list-page-card">
                <RepositoryLinkDialog mod={this.state.repoLinkMod ?? null}
                                      onClose={() => this.setState({repoLinkMod: null})}/>
                {this.state.updateReviews && this.state.updateReviews.length > 0 && (
                    <UpdateReviewDialog reviews={this.state.updateReviews}
                                        onClose={async (applied) => {
                                            this.setState({updateReviews: null});
                                            if (applied > 0) {
                                                await this.updateTreeView();
                                                await this.updateCountLabel();
                                            }
                                        }}/>
                )}
                <ProfileEditDialog ref={this.profileEditDialogRef}/>
                <InputDialog ref={this.inputDialogRef}/>
                <Spin spinning={this.state.loading}
                      delay={500}
                      size={"large"}
                      indicator={null}
                      description={
                          <Flex gap={"large"}
                                vertical={false}
                                className="home-loading-tip"
                          >
                              <LoadingOutlined spin/>
                              <span>{t("Loading")}</span>
                              <Button type={"text"}
                                      icon={<CloseOutlined/>}
                                      onClick={() => {
                                          this.setState({
                                              loading: false,
                                          })
                                      }}
                              />
                          </Flex>
                      }
                >
                    <Flex vertical={true}>
                        <Space separator={<Divider orientation="vertical"/>} size={2}
                               className="home-menu-bar">
                            <Typography.Link>
                                <Tooltip title={t("Save Changes")}>
                                    <Button icon={<SaveOutlined/>} type={"text"}
                                            className={`tour-step-save ${this.state.hasUnsavedChanges ? "save-btn-unsaved" : ""}`}
                                            onClick={this.onMenuBarSaveChangesClick}/>
                                </Tooltip>
                                <Tooltip title={t("Uninstall Mods From Game")}>
                                    <Button icon={<DeleteOutlined/>} type={"text"}
                                            onClick={this.onMenuBarUninstallModsClick}/>
                                </Tooltip>
                                <Tooltip title={t("Add Mod")}>
                                    <Button icon={<PlusCircleOutlined/>} type={"text"}
                                            className="tour-step-add-mod"
                                            onClick={this.onMenuBarAddModClick}/>
                                </Tooltip>
                                <Tooltip title={t("Check Mod Updates")}>
                                    <Button icon={<SyncOutlined/>} type={"text"} onClick={this.onMenuBarUpdateClick}/>
                                </Tooltip>
                                <Tooltip title={t("Copy List")}>
                                    <Button icon={<CopyOutlined/>} type={"text"} onClick={this.onMenuBarCopyListClick}/>
                                </Tooltip>
                                <Tooltip title={t("mintImport.button")}>
                                    <Button icon={<ImportOutlined/>} type={"text"}
                                            onClick={() => openMintImport()}/>
                                </Tooltip>
                                <Tooltip title={t("Clean Missing Local Mods")}>
                                    <Button icon={<ClearOutlined/>} type={"text"} onClick={this.onMenuBarCleanMissingLocalModsClick}/>
                                </Tooltip>
                                <Tooltip title={t("Check Conflicts")}>
                                    <Button icon={<WarningOutlined/>} type={"text"} onClick={this.onMenuBarCheckConflictsClick}/>
                                </Tooltip>
                            </Typography.Link>
                            {
                                this.state.displayMode === "ListView" &&
                                <Typography.Link>
                                    <Tooltip title="List View">
                                        <Button icon={<UnorderedListOutlined/>} type={"text"}/>
                                    </Tooltip>
                                    <Tooltip title="Group View">
                                        <Button icon={<TreeViewOutlined/>} type={"text"}/>
                                    </Tooltip>
                                </Typography.Link>
                            }
                            <Typography.Link>
                                <Dropdown
                                    menu={{
                                        items: [
                                            {
                                                key: 'name_asc',
                                                label: t('Name A → Z'),
                                                icon: <SortAscendingOutlined />,
                                            },
                                            {
                                                key: 'name_desc',
                                                label: t('Name Z → A'),
                                                icon: <SortDescendingOutlined />,
                                            },
                                            { type: 'divider' },
                                            {
                                                key: 'time_desc',
                                                label: t('Time New → Old'),
                                                icon: <FieldTimeOutlined />,
                                            },
                                            {
                                                key: 'time_asc',
                                                label: t('Time Old → New'),
                                                icon: <FieldTimeOutlined />,
                                            },
                                            { type: 'divider' },
                                            {
                                                key: 'verified_asc',
                                                label: t('Verified → Sandbox'),
                                                icon: <SortAscendingOutlined />,
                                            },
                                            {
                                                key: 'verified_desc',
                                                label: t('Sandbox → Verified'),
                                                icon: <SortDescendingOutlined />,
                                            },
                                        ],
                                        onClick: this.onSortMenuClick,
                                        selectedKeys: [this.state.sortOrder || 'name_asc'],
                                    }}
                                >
                                    <Tooltip title={t("Sort")}>
                                        <Button icon={<SortAscendingOutlined/>} type={"text"} />
                                    </Tooltip>
                                </Dropdown>
                                {(() => {
                                    const hasFolders = this.getAllFolderKeys().length > 0;
                                    const allOpen = this.allFoldersExpanded();
                                    return (
                                        <Tooltip title={t(allOpen ? "folders.collapseAll" : "folders.expandAll")}>
                                            <Button icon={allOpen ? <VerticalAlignMiddleOutlined/> : <ColumnHeightOutlined/>}
                                                    type={"text"}
                                                    disabled={!hasFolders}
                                                    aria-label={t(allOpen ? "folders.collapseAll" : "folders.expandAll")}
                                                    onClick={() => this.setAllFoldersExpanded(!allOpen)}/>
                                        </Tooltip>
                                    );
                                })()}
                                <Tooltip title={t(ListDisplayOptions.showLocalPaths() ? "list.hideLocalPaths" : "list.showLocalPaths")}>
                                    <Button icon={<FolderOpenOutlined/>}
                                            type={ListDisplayOptions.showLocalPaths() ? "default" : "text"}
                                            onClick={() => {
                                                ListDisplayOptions.setShowLocalPaths(!ListDisplayOptions.showLocalPaths());
                                                this.forceUpdate();
                                            }}/>
                                </Tooltip>
                            </Typography.Link>
                            <Typography.Link className="tour-step-profile">
                                <Select
                                    size={"small"}
                                    className="w-300"
                                    value={this.state.defaultProfile}
                                    options={this.state.profileOptions}
                                    onChange={this.onSelectChange}
                                />
                                <Tooltip title={t("Edit Profile")}>
                                    <Button icon={<EditOutlined/>} type={"text"} onClick={this.onEditProfileClick}/>
                                </Tooltip>
                            </Typography.Link>
                            <Typography.Link>
                                <SearchBox onUpdateTreeView={this.updateTreeView}/>
                            </Typography.Link>
                        </Space>
                        <div style={{
                            height: window.innerHeight - 145 - this.logPanelOffset,
                            overflow: "hidden",
                            position: "relative",
                        }}>
                            <TreeView
                                treeData={this.state.treeData}
                                isMultiSelect={this.state.isMultiSelect}
                                expandedKeys={this.state.expandedKeys}
                                selectedKeys={this.state.selectedKeys}
                                checkedKeys={this.state.checkedKeys}
                                virtual={this.state.virtual}
                                height={window.innerHeight - 145 - this.logPanelOffset}
                                onMenuClick={this.onMenuClick}
                                onUpdateTreeView={this.updateTreeView}
                                onCountLabelUpdate={this.updateCountLabel}
                                onTreeNodeSelect={this.onTreeNodeSelect}
                                onTreeNodeCheck={this.onTreeNodeCheck}
                                onTreeNodeExpand={this.onTreeNodeExpand}
                                onTreeRightClick={this.onTreeRightClick}
                                onTreeRowClick={this.onTreeRowClick}
                                onVirtualStateChange={(virtual) => {
                                    this.setState({ virtual });
                                }}
                                onModListChange={() => this.refreshUnsavedState()}
                            />
                        </div>
                        <Flex className="home-footer-bar" gap={4} align="center"
                              style={{ position: "relative", zIndex: 5 }}>
                            <Tooltip title={t("multi.checkboxHint")} mouseEnterDelay={0.4}>
                                <Checkbox checked={!!this.state.isMultiSelect}
                                          onChange={this.onMultiCheckboxChange}
                                />
                            </Tooltip>
                            {
                                this.state.isMultiSelect === true &&
                                <Space size={4} className="mr-auto">
                                    <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                                        {t("multi.selected", { count: this.getBulkOpKeys().filter(k => k.startsWith("mod-")).length })}
                                    </Typography.Text>
                                    <Button type="text"
                                            size={"small"}
                                            icon={this.isAllSelected() ? <MinusSquareOutlined/> : <CheckSquareOutlined/>}
                                            onClick={this.onMultiSelectAllClick}>
                                        {this.isAllSelected() ? t("Deselect All") : t("All")}
                                    </Button>
                                    <Button type="text"
                                            size={"small"}
                                            icon={<CloseCircleOutlined/>}
                                            onClick={this.onMultiDeleteClick}>
                                        {t("Delete")}
                                    </Button>
                                    <Dropdown trigger={["click"]}
                                              menu={{
                                                  items: this.getFolderChoices().map(f => ({ key: f.key, label: f.label, icon: <FolderOutlined/> })),
                                                  onClick: ({ key }) => void this.onMultiMoveClick(String(key)),
                                                  style: { maxHeight: 360, overflowY: "auto" },
                                              }}>
                                        <Button type="text" size={"small"} icon={<FolderOpenOutlined/>}>
                                            {t("multi.moveTo")}
                                        </Button>
                                    </Dropdown>
                                    <Button type="text" size={"small"}
                                            icon={<PlayCircleOutlined/>}
                                            onClick={() => this.onMultiEnableClick(true)}>
                                        {t("Enable")}
                                    </Button>
                                    <Button type="text" size={"small"}
                                            icon={<PauseCircleOutlined/>}
                                            onClick={() => this.onMultiEnableClick(false)}>
                                        {t("Disable")}
                                    </Button>
                                    <Button type="text" size={"small"}
                                            icon={<SyncOutlined/>}
                                            onClick={this.onMultiUpdateClick}>
                                        {t("Update")}
                                    </Button>
                                    <Button type="text" size={"small"}
                                            icon={<CopyOutlined/>}
                                            onClick={this.onMultiCopyClick}>
                                        {t("Copy")}
                                    </Button>
                                </Space>
                            }
                            <CountLabel enableCount={this.state.enableCount} totalCount={this.state.totalCount}/>
                        </Flex>
                    </Flex>
                </Spin>
            </div>
        )
    }
}
