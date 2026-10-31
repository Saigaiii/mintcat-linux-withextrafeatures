/**
 * Moving a mod to another install position in the tree data the list shows (folders with
 * children, mods as leaves). Pure functions, so they can be tested without the app.
 */

/** Leaf keys in tree order, with the folder keys above each */
export function leavesInOrder(nodes: any[] | undefined, path: string[] = [], out: { node: any; folders: string[] }[] = []) {
    for (const node of nodes ?? []) {
        if (node.isLeaf) {
            out.push({node, folders: path});
        } else {
            leavesInOrder(node.children, node.key === 'root' ? path : [...path, String(node.key)], out);
        }
    }
    return out;
}

/** Remove `node` from the tree; returns where it was (to put it back), or null when not found */
export function detach(nodes: any[] | undefined, node: any): { list: any[]; index: number } | null {
    if (!nodes) return null;
    const index = nodes.indexOf(node);
    if (index >= 0) {
        nodes.splice(index, 1);
        return {list: nodes, index};
    }
    for (const child of nodes) {
        const found = detach(child.children, node);
        if (found) return found;
    }
    return null;
}

/** Put `node` right before/after `anchor`, in the anchor's folder; true when the anchor was found */
export function placeNextTo(nodes: any[] | undefined, anchor: any, node: any, after: boolean): boolean {
    if (!nodes) return false;
    const index = nodes.indexOf(anchor);
    if (index >= 0) {
        nodes.splice(after ? index + 1 : index, 0, node);
        return true;
    }
    return nodes.some(child => placeNextTo(child.children, anchor, node, after));
}

/**
 * Move the mod with key `sourceKey` so it becomes number `position` (1-based) in `order` (mod
 * ids in install order): right before the mod now at that number when moving up, right after
 * it when moving down, in that mod's folder. Changes `treeData` in place. Returns the folder
 * keys above its new place, or null when nothing moved.
 */
export function moveToPosition(treeData: any[], order: number[], sourceKey: string, position: number): string[] | null {
    if (!Number.isFinite(position)) return null;
    const leaves = leavesInOrder(treeData);
    const source = leaves.find(l => String(l.node.key) === sourceKey);
    if (!source) return null;
    const from = order.indexOf(source.node.modId);
    const to = Math.min(Math.max(Math.round(position), 1), order.length) - 1;
    if (from < 0 || to < 0 || to === from) return null;
    const anchor = leaves.find(l => l.node.modId === order[to]);
    if (!anchor || anchor.node === source.node) return null;
    const was = detach(treeData, source.node);
    if (!was) return null;
    if (!placeNextTo(treeData, anchor.node, source.node, to > from)) {
        // put it back where it was rather than lose it
        was.list.splice(was.index, 0, source.node);
        return null;
    }
    return anchor.folders;
}
