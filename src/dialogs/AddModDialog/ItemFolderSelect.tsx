import React from "react";
import {Select} from "antd";
import {t} from "i18next";
import type {ItemFolders} from "@/dialogs/AddModDialog/ItemFolders";

/**
 * Folder choice next to one mod in the Add Mod dialog. Shown plain while the mod follows the
 * dialog's folder, outlined once it has its own. Hidden when there's only one folder.
 */
export function ItemFolderSelect({folders, itemKey, width = 130}: {
    folders?: ItemFolders;
    itemKey: string;
    width?: number;
}) {
    if (!folders || folders.options.length < 2) return null;
    const own = folders.overrides[itemKey];
    // a folder deleted meanwhile no longer counts (the mod goes to the dialog's folder)
    const hasOwn = own != null && own !== folders.defaultId && folders.options.some(o => o.value === own);
    const value = hasOwn ? own : folders.defaultId;
    const label = folders.options.find(o => o.value === value)?.label;
    return (
        <span title={label ? `${t("addMod.itemFolderTip")}: ${label}` : t("addMod.itemFolderTip")}
              aria-label={t("addMod.itemFolderTip")}
              onClick={(e) => e.stopPropagation()}
              style={{flexShrink: 0, display: "inline-flex"}}>
            <Select size="small"
                    className={hasOwn ? "add-mod-item-folder own" : "add-mod-item-folder"}
                    variant={hasOwn ? "outlined" : "borderless"}
                    value={value}
                    options={folders.options}
                    popupMatchSelectWidth={false}
                    showSearch
                    optionFilterProp="label"
                    // a subfolder shows its own name here ("Custom Icons"), its path on hover
                    labelRender={({label: path}) => {
                        const text = String(path ?? "");
                        return <span title={text}>{text.split(" / ").pop()}</span>;
                    }}
                    style={{width}}
                    onChange={(id: number) => folders.set(itemKey, id)}/>
        </span>
    );
}
