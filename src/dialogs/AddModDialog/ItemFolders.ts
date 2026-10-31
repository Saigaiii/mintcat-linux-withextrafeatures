/**
 * Folder per mod in the Add Mod dialog: every listed mod goes to the dialog's folder unless it
 * was given its own. Choices are kept by item key ("local:<path>", "link:<url>", "modio:<id>"),
 * so a file or link removed and added again keeps the folder picked for it.
 */

export type FolderOverrides = Record<string, number>;

export const itemKey = {
    local: (path: string) => `local:${path}`,
    link: (url: string) => `link:${url}`,
    modio: (id: number | string) => `modio:${id}`,
};

/** What the tabs get to show a folder choice next to each mod */
export interface ItemFolders {
    options: { label: string; value: number }[];
    /** The dialog's folder: mods without their own go there */
    defaultId: number;
    overrides: FolderOverrides;
    set(key: string, folderId: number): void;
    /** The tab's current mods (keys), so the dialog can count those going elsewhere */
    report(prefix: string, keys: string[]): void;
}

/** Pick a folder for one mod; picking the dialog's folder makes it follow that folder again */
export function setItemFolder(overrides: FolderOverrides, key: string, folderId: number, defaultId: number): FolderOverrides {
    const next = {...overrides};
    if (folderId === defaultId) delete next[key];
    else next[key] = folderId;
    return next;
}

/**
 * The dialog's folder changed: mods whose own folder is the new one follow it from now on
 * (others keep the folder picked for them).
 */
export function followNewDefault(overrides: FolderOverrides, defaultId: number): FolderOverrides {
    const next: FolderOverrides = {};
    for (const [key, id] of Object.entries(overrides)) {
        if (id !== defaultId) next[key] = id;
    }
    return next;
}

/** How many of the listed mods go to another folder than the dialog's */
export function countElsewhere(overrides: FolderOverrides, keys: string[], defaultId: number): number {
    return [...new Set(keys)].filter(k => overrides[k] != null && overrides[k] !== defaultId).length;
}

/** Own folders of the given items, by item (only those going elsewhere) */
export function ownFolders<T extends string | number>(items: T[], keyOf: (item: T) => string,
                                                      overrides: FolderOverrides, defaultId: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items) {
        const id = overrides[keyOf(item)];
        if (id != null && id !== defaultId) result[String(item)] = id;
    }
    return result;
}

/**
 * Where one mod goes: its own folder if it still exists, else the dialog's folder.
 * `validIds` empty or missing: not checked.
 */
export function folderFor(own: Record<string, number> | undefined, item: string, defaultId: number,
                          validIds?: Set<number>): number {
    const id = own?.[item];
    if (id == null) return defaultId;
    if (validIds && validIds.size > 0 && !validIds.has(id)) return defaultId;
    return id;
}

/** Items split by the folder they go to, in first-seen order */
export function byFolder<T>(items: T[], folderOf: (item: T) => number): Map<number, T[]> {
    const groups = new Map<number, T[]>();
    for (const item of items) {
        const id = folderOf(item);
        const list = groups.get(id) ?? [];
        list.push(item);
        groups.set(id, list);
    }
    return groups;
}
