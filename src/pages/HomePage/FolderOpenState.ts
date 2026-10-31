/**
 * Which folders are open, kept across rebuilds of the list. Saving the list re-creates folders
 * with new ids, so open folders are remembered by their path of names (Parent, Child). A folder
 * that moved keeps its open state when its name is unique in the list.
 */

/** Between the names in a path: a character no folder name has ("/" can be in a name) */
const SEP = "\u001f";

interface FolderNode {
    key: unknown;
    title?: unknown;
    isLeaf?: boolean;
    children?: FolderNode[];
}

/** Folder key -> path of names, in list order */
export function folderPaths(nodes: FolderNode[] | undefined, rename?: { key: string; name: string }): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (list: FolderNode[] | undefined, parent: string) => {
        for (const node of list ?? []) {
            const key = String(node.key);
            if (node.isLeaf || !key.startsWith("folder-")) continue;
            const name = rename?.key === key ? rename.name : String(node.title ?? "");
            const path = parent ? `${parent}${SEP}${name}` : name;
            out.set(key, path);
            walk(node.children, path);
        }
    };
    walk(nodes, "");
    return out;
}

/** Paths of the open folders (a folder being renamed counts under its new name) */
export function rememberOpen(nodes: FolderNode[] | undefined, openKeys: unknown[], rename?: { key: string; name: string }): string[] {
    const paths = folderPaths(nodes, rename);
    const out: string[] = [];
    for (const key of openKeys) {
        const path = paths.get(String(key));
        if (path !== undefined) out.push(path);
    }
    return out;
}

/** Keys of the remembered folders in a rebuilt list; a path that's gone matches a folder with that unique name */
export function restoreOpen(nodes: FolderNode[] | undefined, paths: string[]): string[] {
    const byPath = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const [key, path] of folderPaths(nodes)) {
        byPath.set(path, key);
        const name = path.split(SEP).pop() ?? path;
        byName.set(name, [...(byName.get(name) ?? []), key]);
    }
    const out = new Set<string>();
    for (const path of paths) {
        const key = byPath.get(path);
        if (key) {
            out.add(key);
            continue;
        }
        const same = byName.get(path.split(SEP).pop() ?? path);
        if (same?.length === 1) out.add(same[0]);
    }
    return [...out];
}
