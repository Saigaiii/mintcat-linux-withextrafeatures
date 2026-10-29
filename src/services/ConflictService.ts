/**
 * Mod Conflict Service
 * 
 * Manages conflict detection state for mods in memory.
 * Conflicts are determined by detecting files with the same path across multiple mods.
 */

import { emitEvent } from "@/events";

/**
 * Conflict information for a single mod
 */
export interface ConflictInfo {
    /** The mod ID that has conflicts */
    modId: number;
    /** List of mod IDs that conflict with this mod */
    conflictingMods: number[];
    /** List of file paths that are in conflict */
    conflictingFiles: string[];
}

/**
 * Backend response structure for conflict check
 */
export interface ModConflictResponse {
    mod_id: number;
    conflicting_mods: number[];
    conflicting_files: string[];
}

// Module-level state storage for conflict information
const conflictMap = new Map<number, ConflictInfo>();

/**
 * Extra info captured by the conflict check so the UI can name mods
 */
export interface ConflictModMeta {
    name: string;
    /** Big Audio-tagged paks are copied as their own pak, so list order does not decide them */
    audioOnly: boolean;
}

const modMetaMap = new Map<number, ConflictModMeta>();

/**
 * Files shared by one pair of mods. `winnerId` is the mod higher in the list.
 */
export interface ConflictPair {
    winnerId: number;
    loserId: number;
    /** Shared files grouped per asset (e.g. .uasset + .uexp shown once) */
    assets: ConflictAsset[];
    /** True if either mod is installed as a separate audio pak (winner not decided by list order) */
    orderUncertain: boolean;
}

export interface ConflictAsset {
    /** Path without the extension, minus the "fsd/content/" prefix */
    path: string;
    extensions: string[];
}

const ASSET_EXTENSIONS = ['.uasset', '.uexp', '.ubulk', '.umap', '.uptnl'];

function groupFilesByAsset(files: string[]): ConflictAsset[] {
    const groups = new Map<string, Set<string>>();
    for (const file of files) {
        let base = file;
        let ext = '';
        for (const candidate of ASSET_EXTENSIONS) {
            if (file.endsWith(candidate)) {
                base = file.slice(0, -candidate.length);
                ext = candidate;
                break;
            }
        }
        if (!ext) {
            const dot = file.lastIndexOf('.');
            const slash = file.lastIndexOf('/');
            if (dot > slash) {
                base = file.slice(0, dot);
                ext = file.slice(dot);
            }
        }
        const display = base.replace(/^(fsd|roguecore)\/content\//, '');
        if (!groups.has(display)) groups.set(display, new Set());
        if (ext) groups.get(display)!.add(ext);
    }
    return Array.from(groups.entries())
        .map(([path, exts]) => ({ path, extensions: Array.from(exts).sort() }))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * ConflictService - Static service for managing mod conflict state
 */
export class ConflictService {
    /**
     * Set conflicts from backend response
     * Converts snake_case response to camelCase and stores in memory
     */
    static setConflicts(conflicts: ModConflictResponse[], meta?: Map<number, ConflictModMeta>): void {
        const previousModIds = Array.from(conflictMap.keys());
        // Clear existing conflicts
        conflictMap.clear();
        if (meta) {
            modMetaMap.clear();
            meta.forEach((value, key) => modMetaMap.set(key, value));
        }
        
        // Store new conflicts
        for (const conflict of conflicts) {
            const info: ConflictInfo = {
                modId: conflict.mod_id,
                conflictingMods: conflict.conflicting_mods,
                conflictingFiles: conflict.conflicting_files,
            };
            conflictMap.set(info.modId, info);
        }
        
        // Emit event to notify UI components about conflict updates
        // Emit for all mods that might need to update their display
        this.emitUpdateEvents();
        // Mods that no longer conflict lose their warning icon
        for (const modId of previousModIds) {
            if (!conflictMap.has(modId)) {
                emitEvent('mod-conflict-update', { modId, hasConflict: false });
            }
        }
    }
    
    /**
     * Get conflict information for a specific mod
     * @param modId The mod ID to check
     * @returns ConflictInfo if the mod has conflicts, null otherwise
     */
    static getConflict(modId: number): ConflictInfo | null {
        return conflictMap.get(modId) || null;
    }
    
    /**
     * Check if a mod has any conflicts
     * @param modId The mod ID to check
     * @returns true if the mod has conflicts with other mods
     */
    static hasConflict(modId: number): boolean {
        return conflictMap.has(modId);
    }
    
    /**
     * Get all mods that have conflicts
     * @returns Array of mod IDs that have conflicts
     */
    static getConflictingModIds(): number[] {
        return Array.from(conflictMap.keys());
    }
    
    /**
     * Get all conflict information
     * @returns Array of all ConflictInfo objects
     */
    static getAllConflicts(): ConflictInfo[] {
        return Array.from(conflictMap.values());
    }
    
    static getModName(modId: number): string {
        return modMetaMap.get(modId)?.name || `#${modId}`;
    }

    static isAudioOnly(modId: number): boolean {
        return modMetaMap.get(modId)?.audioOnly === true;
    }

    /**
     * Map of file path -> every mod (in the last check) containing it, for shared files only.
     * Rebuilt from the per-mod results, which list every shared file of that mod.
     */
    private static buildFileIndex(): Map<string, number[]> {
        const index = new Map<string, number[]>();
        for (const info of conflictMap.values()) {
            for (const file of info.conflictingFiles) {
                const list = index.get(file) ?? [];
                if (!list.includes(info.modId)) list.push(info.modId);
                index.set(file, list);
            }
        }
        return index;
    }

    /**
     * Every pair of mods sharing files. The pair's winner is whichever mod is
     * higher in the install order (top of the list wins).
     * @param order mod ids in install order (see utils/ModDisplayOrder)
     * @param onlyModId restrict to pairs involving this mod
     */
    static getPairs(order: number[], onlyModId?: number): ConflictPair[] {
        const position = new Map<number, number>();
        order.forEach((id, i) => position.set(id, i));
        const pos = (id: number) => position.get(id) ?? Number.MAX_SAFE_INTEGER;

        const pairFiles = new Map<string, { a: number; b: number; files: string[] }>();
        for (const [file, mods] of this.buildFileIndex()) {
            for (let i = 0; i < mods.length; i++) {
                for (let j = i + 1; j < mods.length; j++) {
                    const a = Math.min(mods[i], mods[j]);
                    const b = Math.max(mods[i], mods[j]);
                    if (onlyModId !== undefined && a !== onlyModId && b !== onlyModId) continue;
                    const key = `${a}:${b}`;
                    const entry = pairFiles.get(key) ?? { a, b, files: [] };
                    entry.files.push(file);
                    pairFiles.set(key, entry);
                }
            }
        }

        const pairs: ConflictPair[] = [];
        for (const { a, b, files } of pairFiles.values()) {
            const [winnerId, loserId] = pos(a) <= pos(b) ? [a, b] : [b, a];
            pairs.push({
                winnerId,
                loserId,
                assets: groupFilesByAsset(files),
                orderUncertain: this.isAudioOnly(a) || this.isAudioOnly(b),
            });
        }
        return pairs.sort((x, y) =>
            pos(x.winnerId) - pos(y.winnerId) || pos(x.loserId) - pos(y.loserId)
        );
    }

    /**
     * Clear all conflict data
     */
    static clearAll(): void {
        const previousModIds = Array.from(conflictMap.keys());
        conflictMap.clear();
        
        // Emit update events for previously conflicting mods
        for (const modId of previousModIds) {
            emitEvent('mod-conflict-update', { modId, hasConflict: false });
        }
    }
    
    /**
     * Emit update events for all mods in the conflict map
     */
    private static emitUpdateEvents(): void {
        for (const [modId, _] of conflictMap) {
            emitEvent('mod-conflict-update', { modId, hasConflict: true });
        }
    }
    
    /**
     * Get a formatted string describing conflicts for a mod
     * @param modId The mod ID to get description for
     * @returns Human-readable conflict description or empty string
     */
    static getConflictDescription(modId: number): string {
        const conflict = this.getConflict(modId);
        if (!conflict) return '';
        
        const fileCount = conflict.conflictingFiles.length;
        const modCount = conflict.conflictingMods.length;
        
        return `${fileCount} file(s) conflict with ${modCount} other mod(s)`;
    }
}
