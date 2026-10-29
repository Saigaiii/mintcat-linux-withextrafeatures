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
    /** Content fingerprint per conflicting file (equal in two mods = identical file) */
    fileHashes: Record<string, string>;
    /** All files in the mod (0 if unknown) */
    totalFiles: number;
}

/**
 * Backend response structure for conflict check
 */
export interface ModConflictResponse {
    mod_id: number;
    conflicting_mods: number[];
    conflicting_files: string[];
    file_hashes?: Record<string, string>;
    total_files?: number;
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
 * How much a conflict matters:
 *  - harmless: both mods ship the exact same file (verified by content)
 *  - cosmetic: textures, materials, meshes, sounds, effects... only the winner's look/sound is used
 *  - gameplay: blueprints, data assets, maps, or anything unrecognized; the losing mod's
 *    changes to it are lost, so it may not work (fully or partly)
 */
export type ConflictRating = 'harmless' | 'cosmetic' | 'gameplay';

const RATING_RANK: Record<ConflictRating, number> = {harmless: 0, cosmetic: 1, gameplay: 2};

export function worseRating(a: ConflictRating, b: ConflictRating): ConflictRating {
    return RATING_RANK[a] >= RATING_RANK[b] ? a : b;
}

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
    /** Worst rating among the shared assets */
    rating: ConflictRating;
}

export interface ConflictAsset {
    /** Path without the extension, minus the "fsd/content/" prefix */
    path: string;
    extensions: string[];
    rating: ConflictRating;
}

/** Overall state of one mod's conflicts, from that mod's side */
export type ModConflictSummary =
    | 'noEffect'       // every file it has is replaced by mods above it
    | 'losesGameplay'  // a mod above it replaces some of its gameplay files
    | 'losesCosmetic'  // a mod above it replaces only some of its looks/sounds
    | 'harmless'       // it only shares identical files
    | 'winsAll';       // it's above every mod it shares files with

// Unreal / DRG naming conventions for assets that only affect looks or sound
const COSMETIC_PREFIXES = [
    't_', 'tx_', 'tex_', 'm_', 'mi_', 'mf_', 'mat_', 'sm_', 'sk_', 'skel_', 'phys_', 'pa_',
    'a_', 'am_', 'anim_', 'ns_', 'ps_', 'p_', 'fx_', 'vfx_', 'sc_', 'sw_', 'snd_', 'sfx_',
    'mus_', 'vo_', 'font_', 'icon_', 'img_',
];
const GAMEPLAY_PREFIXES = ['bp_', 'abp_', 'wbp_', 'id_', 'dt_', 'da_', 'gm_', 'pc_', 'gd_'];
const COSMETIC_FOLDERS = [
    'textures', 'texture', 'materials', 'material', 'meshes', 'mesh', 'audio', 'sound', 'sounds',
    'music', 'vfx', 'fx', 'particles', 'animations', 'animation', 'fonts', 'localization',
];
const COSMETIC_EXTENSIONS = ['.wem', '.bnk', '.ufont', '.locres', '.png', '.jpg', '.bk2', '.bik', '.mp4'];

/** Best guess from the asset's name and folder; unknown counts as gameplay to be safe */
export function classifyAsset(path: string, extensions: string[]): 'cosmetic' | 'gameplay' {
    const lower = path.toLowerCase();
    const parts = lower.split('/');
    const base = parts[parts.length - 1];
    if (extensions.includes('.umap')) return 'gameplay';
    if (GAMEPLAY_PREFIXES.some(prefix => base.startsWith(prefix))) return 'gameplay';
    if (extensions.length > 0 && extensions.every(ext => COSMETIC_EXTENSIONS.includes(ext))) return 'cosmetic';
    if (COSMETIC_PREFIXES.some(prefix => base.startsWith(prefix))) return 'cosmetic';
    if (parts.slice(0, -1).some(folder => COSMETIC_FOLDERS.includes(folder))) return 'cosmetic';
    return 'gameplay';
}

const ASSET_EXTENSIONS = ['.uasset', '.uexp', '.ubulk', '.umap', '.uptnl'];

function splitAsset(file: string): { base: string; ext: string } {
    for (const candidate of ASSET_EXTENSIONS) {
        if (file.endsWith(candidate)) {
            return {base: file.slice(0, -candidate.length), ext: candidate};
        }
    }
    const dot = file.lastIndexOf('.');
    const slash = file.lastIndexOf('/');
    return dot > slash ? {base: file.slice(0, dot), ext: file.slice(dot)} : {base: file, ext: ''};
}

function displayAssetPath(base: string): string {
    return base.replace(/^(fsd|roguecore)\/content\//, '');
}

/**
 * Group shared files into assets and rate each one.
 * @param identical files whose content is the same in both mods
 */
function groupFilesByAsset(files: string[], identical?: Set<string>): ConflictAsset[] {
    const groups = new Map<string, { exts: Set<string>; files: string[] }>();
    for (const file of files) {
        const {base, ext} = splitAsset(file);
        const display = displayAssetPath(base);
        if (!groups.has(display)) groups.set(display, {exts: new Set(), files: []});
        const group = groups.get(display)!;
        if (ext) group.exts.add(ext);
        group.files.push(file);
    }
    return Array.from(groups.entries())
        .map(([path, group]) => {
            const extensions = Array.from(group.exts).sort();
            const allIdentical = !!identical && group.files.every(f => identical.has(f));
            const rating: ConflictRating = allIdentical ? 'harmless' : classifyAsset(path, extensions);
            return {path, extensions, rating};
        })
        .sort((a, b) => RATING_RANK[b.rating] - RATING_RANK[a.rating] || a.path.localeCompare(b.path));
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
                fileHashes: conflict.file_hashes ?? {},
                totalFiles: conflict.total_files ?? 0,
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
            const hashesA = conflictMap.get(a)?.fileHashes ?? {};
            const hashesB = conflictMap.get(b)?.fileHashes ?? {};
            const identical = new Set(files.filter(f => hashesA[f] && hashesA[f] === hashesB[f]));
            const assets = groupFilesByAsset(files, identical);
            pairs.push({
                winnerId,
                loserId,
                assets,
                orderUncertain: this.isAudioOnly(a) || this.isAudioOnly(b),
                rating: assets.reduce<ConflictRating>((r, asset) => worseRating(r, asset.rating), 'harmless'),
            });
        }
        // Worth-worrying-about first, then by list position
        return pairs.sort((x, y) =>
            RATING_RANK[y.rating] - RATING_RANK[x.rating] ||
            pos(x.winnerId) - pos(y.winnerId) || pos(x.loserId) - pos(y.loserId)
        );
    }

    /**
     * True when every file of the mod is also in a mod above it, so none of its files are used.
     */
    static hasNoEffect(modId: number, order: number[]): boolean {
        const info = conflictMap.get(modId);
        if (!info || info.totalFiles === 0 || this.isAudioOnly(modId)) return false;
        if (info.conflictingFiles.length < info.totalFiles) return false;
        const position = new Map<number, number>();
        order.forEach((id, i) => position.set(id, i));
        const mine = position.get(modId);
        if (mine === undefined) return false;
        const index = this.buildFileIndex();
        return info.conflictingFiles.every(file =>
            (index.get(file) ?? []).some(other => other !== modId && !this.isAudioOnly(other) &&
                (position.get(other) ?? Number.MAX_SAFE_INTEGER) < mine));
    }

    /** One-word state of a mod's conflicts, from its own side */
    static summarize(modId: number, order: number[]): ModConflictSummary {
        if (this.hasNoEffect(modId, order)) return 'noEffect';
        let worst: ConflictRating | null = null;
        let anyShared = false;
        for (const pair of this.getPairs(order, modId)) {
            anyShared = true;
            if (pair.loserId !== modId || pair.orderUncertain) continue;
            worst = worst ? worseRating(worst, pair.rating) : pair.rating;
        }
        if (worst === 'gameplay') return 'losesGameplay';
        if (worst === 'cosmetic') return 'losesCosmetic';
        if (worst === 'harmless') return 'harmless';
        return anyShared ? 'winsAll' : 'harmless';
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
