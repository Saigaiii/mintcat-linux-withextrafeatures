import {InstallOrder} from "@/services/ListDisplay";
import React from "react";
import {flushSync} from "react-dom";
import {Tree, TreeProps} from 'antd';
import type {CompleteModData} from "@/storage/dao/ModDAO";
import {StorageAPI} from "@/storage";
import {autoBind} from "@/utils/ReactUtils";
import {TreeViewModel} from "./TreeViewModel";
import {FOLDER_COLOR_PREFIX, TreeViewConverter} from "./TreeViewConverter";
import {ModListAppearance} from "@/services/ModListAppearance";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel.ts";
import {TreeViewItem} from "./TreeViewItem";
import {dragAndDrop} from "./DragAndDropTree";
import {DragAutoScroll} from "./DragAutoScroll";
import {moveToPosition} from "./TreeMoves";
import { IoC } from "@/core/IoC";

/** A folder's "Parent/Child" path in a tree, as folder colors are keyed (null when not a folder there) */
function folderPathOf(nodes: any[] | undefined, key: string, path: string[] = []): string | null {
    for (const node of nodes ?? []) {
        if (node.isLeaf) continue;
        const here = node.key === 'root' ? path : [...path, String(node.title ?? "")];
        if (node.key === key) return here.join("/");
        const found = folderPathOf(node.children, key, here);
        if (found) return found;
    }
    return null;
}

/** A moved folder keeps its color (and its subfolders' colors) at its new place */
async function carryFolderColors(key: string, before: string | null, treeAfter: any[]): Promise<void> {
    if (!before) return;
    const after = folderPathOf(treeAfter, key);
    if (after && after !== before) {
        await ModListAppearance.renameFolderKey(FOLDER_COLOR_PREFIX + before, FOLDER_COLOR_PREFIX + after);
    }
}


export interface FolderInfo {
    key: string;
    title: string;
}

export interface TreeViewProps {
    treeData?: TreeProps['treeData'];
    isMultiSelect?: boolean;
    expandedKeys?: any[];
    selectedKeys?: any[];
    checkedKeys?: any[];
    virtual?: boolean;
    height?: number;
    onMenuClick: (key: string, nodeKey: string) => void;
    onUpdateTreeView?: () => void;
    onCountLabelUpdate?: () => Promise<void>;
    onTreeNodeSelect?: (keys: any, info?: any) => void;
    onTreeNodeCheck?: (checkedKeys: any) => void;
    onTreeNodeExpand?: (keys: any) => void;
    onTreeRightClick?: (info: any) => void;
    onTreeRowClick?: (nodeKey: string, e: React.MouseEvent) => void;
    onVirtualStateChange?: (virtual: boolean) => void;
    onModListChange?: () => void;
}

export class TreeView extends React.Component<TreeViewProps> {
    private folderItemOrderMap = new Map<string, number>();
    /** treeData the folder list / per-folder numbers below were computed from */
    private derivedFrom: unknown = null;
    private folderListCache: FolderInfo[] = [];

    private readonly wrapperRef = React.createRef<HTMLDivElement>();
    private readonly treeRef = React.createRef<any>();
    private readonly autoScroll = new DragAutoScroll(
        () => this.wrapperRef.current?.querySelector<HTMLElement>(".ant-tree-list-holder") ?? null,
        top => flushSync(() => this.treeRef.current?.scrollTo?.(top)));

    componentWillUnmount() {
        this.autoScroll.stop();
    }

    shouldComponentUpdate(nextProps: TreeViewProps) {
        return (
            nextProps.treeData !== this.props.treeData ||
            nextProps.expandedKeys !== this.props.expandedKeys ||
            nextProps.selectedKeys !== this.props.selectedKeys ||
            nextProps.checkedKeys !== this.props.checkedKeys ||
            nextProps.isMultiSelect !== this.props.isMultiSelect ||
            nextProps.virtual !== this.props.virtual ||
            nextProps.height !== this.props.height
        );
    }

    /**
     * 从 treeData 中提取所有文件夹信息
     */
    private getFolderList(): FolderInfo[] {
        // Called for every row; the list only changes with treeData (also keeps the array
        // identity stable so memoized rows don't re-render)
        this.refreshDerived();
        return this.folderListCache;
    }

    /** Recompute the folder list and per-folder numbers when treeData changed */
    private refreshDerived(): void {
        if (this.derivedFrom === this.props.treeData) return;
        this.derivedFrom = this.props.treeData;
        this.folderListCache = this.collectFolderList();
        this.buildFolderItemOrderMap();
    }

    private collectFolderList(): FolderInfo[] {
        const folders: FolderInfo[] = [];
        
        // Subfolders are shown with their path ("Cosmetics / Custom Icons")
        const collectFolders = (nodes: any[], path: string[]) => {
            for (const node of nodes) {
                const isFolder = !node.isLeaf && node.key !== 'root';
                const nodePath = isFolder ? [...path, String(node.title ?? "")] : path;
                if (isFolder) {
                    folders.push({
                        key: node.key,
                        title: nodePath.join(" / ")
                    });
                }
                if (node.children) {
                    collectFolders(node.children, nodePath);
                }
            }
        };

        if (this.props.treeData) {
            collectFolders(this.props.treeData as any[], []);
        }

        return folders;
    }

    /**
     * 为每个文件夹下的叶子节点生成从 1 开始的序号
     */
    private buildFolderItemOrderMap(): void {
        this.folderItemOrderMap.clear();

        const assignOrder = (nodes: any[]) => {
            let currentIndex = 1;

            for (const node of nodes) {
                if (node.isLeaf) {
                    this.folderItemOrderMap.set(node.key, currentIndex);
                    currentIndex += 1;
                } else if (node.children) {
                    assignOrder(node.children);
                }
            }
        };

        if (this.props.treeData) {
            assignOrder(this.props.treeData as any[]);
        }
    }

    private getItemOrder(nodeKey: string): number | undefined {
        return this.folderItemOrderMap.get(nodeKey);
    }

    /**
     * 移动节点到指定文件夹（复用拖放逻辑）
     */
    @autoBind
    private async onMoveToFolder(sourceKey: string, targetFolderKey: string) {
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const modList = await this.getAllModsAsList();
        const converter = new TreeViewConverter(modList);

        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = converter.convertToFromRoot(activeRoot);
        TreeViewConverter.filterList = filterList;

        // 查找源节点和目标文件夹节点
        const findNode = (nodes: any[], key: string): any | null => {
            for (const node of nodes) {
                if (node.key === key) {
                    return node;
                }
                if (node.children) {
                    const found = findNode(node.children, key);
                    if (found) return found;
                }
            }
            return null;
        };

        const targetNode = findNode(treeData, targetFolderKey);
        if (!targetNode) {
            console.error(`[TreeView] Target folder not found: ${targetFolderKey}`);
            return;
        }
        // A folder can't go into its own subfolder: taking it out would take the target with it,
        // and the folder and everything in it would drop out of the list
        const sourceNode = findNode(treeData, sourceKey);
        if (sourceNode?.children && findNode(sourceNode.children, targetFolderKey)) {
            console.warn(`[TreeView] Not moving ${sourceKey} into its own subfolder ${targetFolderKey}`);
            return;
        }

        // 构造一个模拟的拖放事件信息
        const mockInfo = {
            node: {
                key: targetFolderKey,
                pos: '0-0', // 简化的位置
                isLeaf: false
            },
            dragNode: {
                key: sourceKey
            },
            dropToGap: false, // 拖入文件夹内部
            dropPosition: 0
        };

        const pathBefore = folderPathOf(treeData, sourceKey);
        const dragTreeData = dragAndDrop(mockInfo, treeData);

        try {
            const profileTreeItem = converter.convertFrom(dragTreeData);

            if (!profileTreeItem || profileTreeItem.children.length === 0) {
                return;
            }

            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            await carryFolderColors(sourceKey, pathBefore, dragTreeData);

            if (this.props.onModListChange) {
                this.props.onModListChange();
            }
            if (this.props.onUpdateTreeView) {
                await this.props.onUpdateTreeView();
            }
        } catch (error) {
            console.error(`[TreeView] Error during move to folder:`, error);
        }
    }

    /**
     * Move a mod so it gets install position `position` (1 = top of the whole list): it goes right
     * before the mod now at that position (moving up) or right after it (moving down), in that
     * mod's folder.
     */
    @autoBind
    private async onMoveToPosition(sourceKey: string, position: number) {
        const order = InstallOrder.get();
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const converter = new TreeViewConverter(await this.getAllModsAsList());
        // Work on the whole list, not only what the search shows
        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = (converter.convertToFromRoot(activeRoot) ?? []) as any[];
        TreeViewConverter.filterList = filterList;

        const folders = moveToPosition(treeData, order, sourceKey, position);
        if (!folders) return;

        try {
            const profileTreeItem = converter.convertFrom(treeData);
            if (!profileTreeItem || profileTreeItem.children.length === 0) return;
            // open the folders it lands in, so it stays in view
            const expanded = (this.props.expandedKeys ?? []).map(String);
            const missing = folders.filter(k => !expanded.includes(k));
            if (missing.length > 0) this.props.onTreeNodeExpand?.([...expanded, ...missing]);

            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            this.props.onModListChange?.();
            await this.props.onUpdateTreeView?.();
            // Highlight it, unless mods are being picked with checkboxes: a plain select would
            // end that and drop the picked mods
            if (!this.props.isMultiSelect) this.props.onTreeNodeSelect?.([sourceKey]);
            requestAnimationFrame(() => this.treeRef.current?.scrollTo?.({key: sourceKey, align: "auto"}));
        } catch (error) {
            console.error(`[TreeView] Error moving ${sourceKey} to position ${position}:`, error);
        }
    }

    @autoBind
    private async onDrop(info: any) {
        this.autoScroll.stop();
        await IoC.get(TreeViewModel);
        const profileVM = await IoC.get(ProfileViewModel);
        const activeRoot = await profileVM.getActiveProfileTreeRoot();
        const modList = await this.getAllModsAsList();
        const converter = new TreeViewConverter(modList);

        const filterList = TreeViewConverter.filterList;
        TreeViewConverter.filterList = [];
        const treeData = converter.convertToFromRoot(activeRoot);
        TreeViewConverter.filterList = filterList;

        // 修复：对于第一个文件夹的特殊处理
        // 当目标是文件夹（非叶子节点）且拖放到间隙但位置是0时，
        // 如果该节点是其父级中的第一个节点，应该视为拖入文件夹内部
        const dropNode = info.node;
        const dropPos = dropNode.pos.split('-');
        const nodeIndex = Number(dropPos[dropPos.length - 1]);
        
        // 如果目标是文件夹，且是第一个节点，且 dropPosition 在节点上方（0）
        // 则修正 dropToGap 为 false，视为拖入文件夹内部
        if (dropNode.isLeaf === false && 
            nodeIndex === 0 && 
            info.dropToGap && 
            info.dropPosition === 0) {
            // 创建修正后的 info 对象
            info = {
                ...info,
                dropToGap: false,
            };
        }

        const dragKey = String(info.dragNode?.key ?? "");
        const pathBefore = folderPathOf(treeData, dragKey);
        const dragTreeData = dragAndDrop(info, treeData);

        try {
            const profileTreeItem = converter.convertFrom(dragTreeData);

            if (!profileTreeItem || profileTreeItem.children.length === 0) {
                return;
            }

            const profileVM = await IoC.get(ProfileViewModel);
            await profileVM.saveProfileTreeToDatabase(profileTreeItem);
            await carryFolderColors(dragKey, pathBefore, dragTreeData);

            if (this.props.onModListChange) {
                this.props.onModListChange();
            }
            if (this.props.onUpdateTreeView) {
                await this.props.onUpdateTreeView();
            }
        } catch (error) {
            console.error(`[TreeView] Error during drag and drop:`, error);
        }
    }

    @autoBind
    private onTreeNodeSelect(keys: any, info?: any) {
        if (this.props.onTreeNodeSelect) {
            this.props.onTreeNodeSelect(keys, info);
        }
    }

    @autoBind
    private onTreeNodeCheck(checkedKeys: any) {
        if (this.props.onTreeNodeCheck) {
            this.props.onTreeNodeCheck(checkedKeys);
        }
    }

    @autoBind
    private onTreeNodeExpand(keys: any) {
        if (this.props.onTreeNodeExpand) {
            this.props.onTreeNodeExpand(keys);
        }
    }

    @autoBind
    private onTreeRightClick(info: any) {
        if (this.props.onTreeRightClick) {
            this.props.onTreeRightClick(info);
        }
    }

    @autoBind
    private onCustomTitleRender(nodeData: any) {
        const folders = this.getFolderList();
        // Global install position (top of the whole list = 1 = wins conflicts); per-folder number as fallback
        const itemOrder = nodeData.isLeaf
            ? (InstallOrder.position(nodeData.modId) ?? this.getItemOrder(nodeData.key))
            : undefined;
        // 必须用 JSX 挂载子组件，不能 TreeViewItem(...) 函数调用，否则 Hooks 会在 antd Tree 内部 memo/effect 中执行，触发 “Do not call Hooks inside useEffect”
        return (
            <TreeViewItem
                nodeData={nodeData}
                onMenuClick={this.props.onMenuClick}
                onCountLabelUpdate={this.props.onCountLabelUpdate}
                folders={folders}
                onMoveToFolder={this.onMoveToFolder}
                onMoveToPosition={InstallOrder.position(nodeData.modId) !== undefined ? this.onMoveToPosition : undefined}
                itemOrder={itemOrder}
                onRowClick={this.props.onTreeRowClick}
            />
        );
    }
    /**
     * Helper method to get all mods from database as CompleteModData array
     */
    private async getAllModsAsList(): Promise<CompleteModData[]> {
        const modsApi = await StorageAPI.getMods();
        const allMods = await modsApi.getAllMods();
        const modIds = allMods.map(m => m.modId!);
        return await modsApi.getBatchCompleteModDataOptimized(modIds);
    }

    render() {
        this.refreshDerived();

        return (
            <div ref={this.wrapperRef}>
            <Tree
                ref={this.treeRef}
                className="ant-tree-content"
                blockNode
                draggable
                focusable={false}
                tabIndex={-1}
                // Stays virtual while dragging: turning it off (the old workaround for
                // ant-design#54610) rendered every row at drag start and on every drop-position
                // change, which made dragging stutter on long lists. DragAutoScroll scrolls the
                // list during a drag.
                virtual
                height={this.props.height ?? window.innerHeight - 145}
                checkable={this.props.isMultiSelect}
                expandedKeys={this.props.expandedKeys}
                selectedKeys={this.props.selectedKeys}
                checkedKeys={this.props.isMultiSelect ? this.props.checkedKeys : undefined}
                treeData={this.props.treeData}
                onCheck={this.onTreeNodeCheck}
                onSelect={this.onTreeNodeSelect}
                onRightClick={this.onTreeRightClick}
                onExpand={this.onTreeNodeExpand}
                onDrop={this.onDrop}
                onDragStart={info => this.autoScroll.start(info.event.target)}
                titleRender={this.onCustomTitleRender}
            />
            </div>
        );
    }
}
