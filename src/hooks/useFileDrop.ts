/**
 * Files dropped on the main window. The main window leaves drag-and-drop to the webview (so the
 * mod list can be reordered by dragging), which means a dropped file used to replace the whole
 * app with the file's contents. Now:
 *  - a .json file (mint's mod_data.json) opens "Import from mint" with it,
 *  - .pak/.zip files open Add Mod → Local with them,
 *  - dropped web links (e.g. a mod.io page dragged from the browser) open Add Mod → Online,
 *  - anything else is ignored with a short hint.
 * Drags that don't carry files or links (the mod list's own reordering) are left alone. The
 * listeners run in the capture phase because the mod list's tree stops drop events on its rows.
 */
import React from "react";
import {t} from "i18next";
import {message} from "antd";
import {openMintImport} from "@/dialogs/MintImportDialog";
import {openWindow} from "@/dialogs/AddModDialog/open.ts";
import {AddModType} from "@/dialogs/AddModDialog/index.tsx";

function isExternalDrag(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes("Files") || types.includes("text/uri-list");
}

function droppedUris(dt: DataTransfer): string[] {
    let list = "";
    try {
        list = dt.getData("text/uri-list") || "";
    } catch {
        list = "";
    }
    return list.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

/** Paths of the dropped files, when the file manager provides them (text/uri-list). */
function droppedPaths(uris: string[]): string[] {
    return uris
        .filter(line => line.startsWith("file://"))
        .map(uri => {
            try {
                return decodeURIComponent(new URL(uri).pathname);
            } catch {
                return "";
            }
        })
        .filter(Boolean);
}

export function useFileDrop() {
    React.useEffect(() => {
        const allow = (e: DragEvent) => {
            if (!isExternalDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        };

        const onDrop = (e: DragEvent) => {
            if (!isExternalDrag(e) || !e.dataTransfer) return;
            e.preventDefault();
            e.stopPropagation();
            const files = Array.from(e.dataTransfer.files);
            const uris = droppedUris(e.dataTransfer);
            const paths = droppedPaths(uris);

            const json = files.find(f => /\.json$/i.test(f.name));
            if (json) {
                const path = paths.find(p => p.endsWith("/" + json.name)) ?? json.name;
                json.text()
                    .then(text => openMintImport({path, text}))
                    .catch(err => message.error(t("mintImport.readFailed", {reason: String(err)})));
                return;
            }
            const jsonPath = paths.find(p => /\.json$/i.test(p));
            if (jsonPath) {
                openMintImport({path: jsonPath}).catch(console.error);
                return;
            }

            const archives = paths.filter(p => /\.(pak|zip)$/i.test(p));
            if (archives.length > 0) {
                openWindow(AddModType.LOCAL, 0, "", undefined, archives).catch(console.error);
                return;
            }
            const links = uris.filter(u => /^https?:\/\//i.test(u));
            if (links.length > 0) {
                openWindow(AddModType.ONLINE, 0, links.join("\n")).catch(console.error);
                return;
            }
            const hasArchive = files.some(f => /\.(pak|zip)$/i.test(f.name));
            message.info(t(hasArchive ? "mintImport.dropLocal" : "mintImport.dropNotJson"));
        };

        window.addEventListener("dragenter", allow, true);
        window.addEventListener("dragover", allow, true);
        window.addEventListener("drop", onDrop, true);
        return () => {
            window.removeEventListener("dragenter", allow, true);
            window.removeEventListener("dragover", allow, true);
            window.removeEventListener("drop", onDrop, true);
        };
    }, []);
}
