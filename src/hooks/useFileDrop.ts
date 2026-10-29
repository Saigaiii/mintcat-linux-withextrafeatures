/**
 * Files dropped on the main window. The main window leaves drag-and-drop to the webview (so the
 * mod list can be reordered by dragging), which means a dropped file used to replace the whole
 * app with the file's contents. Now:
 *  - a .json file (mint's mod_data.json) opens "Import from mint" with it,
 *  - .pak/.zip files open Add Mod → Local with them,
 *  - anything else is ignored with a short hint.
 * Drags that don't carry files (the mod list's own reordering) are left alone.
 */
import React from "react";
import {t} from "i18next";
import {message} from "antd";
import {openMintImport} from "@/dialogs/MintImportDialog";
import {openWindow} from "@/dialogs/AddModDialog/open.ts";
import {AddModType} from "@/dialogs/AddModDialog/index.tsx";

function carriesFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

/** Paths of the dropped files, when the file manager provides them (text/uri-list). */
function droppedPaths(dt: DataTransfer): string[] {
    let list = "";
    try {
        list = dt.getData("text/uri-list") || "";
    } catch {
        list = "";
    }
    return list.split(/\r?\n/)
        .map(line => line.trim())
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
            if (!carriesFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        };

        const onDrop = (e: DragEvent) => {
            if (!carriesFiles(e) || !e.dataTransfer) return;
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files);
            const paths = droppedPaths(e.dataTransfer);

            const json = files.find(f => /\.json$/i.test(f.name));
            if (json) {
                const path = paths.find(p => p.endsWith("/" + json.name)) ?? json.name;
                json.text()
                    .then(text => openMintImport({path, text}))
                    .catch(err => message.error(t("mintImport.readFailed", {reason: String(err)})));
                return;
            }

            const archives = paths.filter(p => /\.(pak|zip)$/i.test(p));
            if (archives.length > 0) {
                openWindow(AddModType.LOCAL, 0, "", undefined, archives).catch(console.error);
                return;
            }
            const hasArchive = files.some(f => /\.(pak|zip)$/i.test(f.name));
            message.info(t(hasArchive ? "mintImport.dropLocal" : "mintImport.dropNotJson"));
        };

        window.addEventListener("dragenter", allow);
        window.addEventListener("dragover", allow);
        window.addEventListener("drop", onDrop);
        return () => {
            window.removeEventListener("dragenter", allow);
            window.removeEventListener("dragover", allow);
            window.removeEventListener("drop", onDrop);
        };
    }, []);
}
