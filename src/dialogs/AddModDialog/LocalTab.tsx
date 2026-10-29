import {open} from "@tauri-apps/plugin-dialog";
import {exists, stat} from "@tauri-apps/plugin-fs";
import {path} from "@tauri-apps/api";
import {useEventListener} from "@/events";
import {getCurrentWindow} from "@tauri-apps/api/window";
import React, {useEffect, useState} from "react";
import {Button, Flex, Form, Input, List, message} from "antd";
import {t} from "i18next";
import {CloseOutlined, FilePptOutlined, FileZipOutlined, FolderOutlined, FolderOpenOutlined, InboxOutlined} from "@ant-design/icons";
import {BackendRuntimeApi} from "@/apis/BackendRuntimeApi";
import {parseLocalPathLine, splitLines} from "@/utils/LocalModPaths";


interface FileItem {
    name: string;
    path: string;
    type: string;  // "folder" | ".pak" | ".zip"
    isUnpackedMod?: boolean;  // true if folder is a valid unpacked mod directory
}

/**
 * Check if a directory is a valid unpacked mod directory
 * A valid unpacked mod directory contains a Content folder with uasset/uexp files
 */
async function isValidUnpackedMod(dirPath: string): Promise<boolean> {
    try {
        return await BackendRuntimeApi.invoke<boolean>('is_valid_unpacked_mod', { path: dirPath });
    } catch (e) {
        console.error('Failed to check unpacked mod:', e);
        return false;
    }
}

async function makeFileItem(filePath: string): Promise<FileItem> {
    const fileInfo = await stat(filePath);
    const fileName = await path.basename(filePath);

    if (fileInfo.isDirectory) {
        // Check if it's a valid unpacked mod directory
        const isUnpacked = await isValidUnpackedMod(filePath);
        return {
            path: filePath,
            name: fileName,
            type: "folder",
            isUnpackedMod: isUnpacked
        };
    }

    return {
        path: filePath,
        name: fileName,
        type: await path.extname(filePath)
    };
}

export const LocalTab = React.forwardRef(({paths, revision}: any, ref) => {

    const [fileList, setFileList] = useState<FileItem[]>([]);
    const [pasteText, setPasteText] = useState<string>("");

    React.useImperativeHandle(ref, () => ({
        submit: () => {
            return fileList.map(file => file.path);
        }
    }));


    /** Returns true if the path is a usable mod (.pak/.zip/unpacked folder) */
    const addFileList = async (filePath: string): Promise<boolean> => {
        try {
            if (!(await exists(filePath))) {
                return false;
            }
        } catch {
            return false;
        }

        const fileInfo = await stat(filePath);
        const fileItem = await makeFileItem(filePath);

        // Accept: .pak files, .zip files, or valid unpacked mod directories
        if (fileInfo.isDirectory) {
            // For directories, only accept if it's a valid unpacked mod
            if (!fileItem.isUnpackedMod) {
                return false;
            }
        } else {
            // For files, only accept .pak or .zip
            if (!/\.(zip|pak)$/i.test(filePath)) {
                return false;
            }
        }

        setFileList(prevList => {
            if (prevList.find(file => file.path === filePath)) {
                return prevList;
            }
            return [...prevList, fileItem];
        });
        return true;
    }

    /** Add every path in pasted text (plain paths, quoted paths or file:// URIs) */
    const addPastedText = async (text: string) => {
        let homeDir: string | undefined;
        try {
            homeDir = await path.homeDir();
        } catch {
            homeDir = undefined;
        }
        let skipped = 0;
        for (const line of splitLines(text)) {
            const localPath = parseLocalPathLine(line, homeDir);
            if (!localPath || !(await addFileList(localPath))) {
                skipped++;
            }
        }
        if (skipped > 0) {
            message.warning(t("localMods.someNotAdded", {count: skipped}));
        }
    }

    const onPaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
        // Files copied in a file manager arrive as text/uri-list; plain text otherwise
        const text = e.clipboardData.getData("text/uri-list") || e.clipboardData.getData("text/plain");
        if (!text) {
            return;
        }
        e.preventDefault();
        setPasteText("");
        await addPastedText(text);
    }

    const onPasteEnter = async () => {
        const text = pasteText;
        setPasteText("");
        if (text.trim()) {
            await addPastedText(text);
        }
    }

    // Paths sent by the clipboard watcher (merged into the list, never replacing it)
    useEffect(() => {
        if (!paths || paths.length === 0) {
            return;
        }
        (async () => {
            for (const p of paths) {
                await addFileList(p);
            }
        })();
    }, [paths, revision]);

    const onSelectPathClick = async () => {
        const results = await open({
            directory: true,
            multiple: true,
        });

        if (results) {
            for (let result of results) {
                await addFileList(result);
            }
        }
    }

    const onSelectFileClick = async () => {
        const results = await open({
            filters: [{
                name: '*',
                extensions: ['pak', 'zip'],
            }],
            multiple: true,
        });

        if (results) {
            for (let result of results) {
                await addFileList(result);
            }
        }
    }

    const registerDragDropEvent = () => {
        getCurrentWindow().onDragDropEvent(
            async (event) => {
                if (event.payload.type === 'drop') {
                    for (let path of event.payload.paths) {
                        await addFileList(path);
                    }
                }
            }
        ).then();
    }

    // ✅ 使用 useEventListener 监听 Tauri 文件拖放事件
    useEventListener('tauri://file-drop', async (event) => {
        // EventRegistry 中的 payload 结构是 { paths, position }，没有 type 字段
        for (let path of event.paths) {
            await addFileList(path);
        }
    });

    const onDeleteClick = (item) => {
        setFileList(fileList.filter(file => file.path !== item.path));
    }

    useEffect(() => {
        registerDragDropEvent();
        return () => {
        }
    }, []);

    return (
        <Form layout="vertical">
            <Flex gap={"small"}>
                <div className={"ant-upload-drag"}
                     style={{flex: 1}}
                     onClick={onSelectPathClick}
                >
                    <p className="app-drag-icon">
                        <FolderOutlined/>
                    </p>
                    <p className="app-drag-hint">
                        {t("Select Folder")}
                    </p>
                </div>
                <div className={"ant-upload-drag"}
                     style={{flex: 1}}
                     onClick={onSelectFileClick}
                >
                    <p className="app-drag-icon">
                        <InboxOutlined/>
                    </p>
                    <p className="app-drag-hint">
                        {t("Select File")}
                    </p>
                </div>
            </Flex>
            <Input style={{marginTop: 8}}
                   value={pasteText}
                   allowClear
                   placeholder={t("localMods.pastePlaceholder")}
                   onChange={(e) => setPasteText(e.target.value)}
                   onPaste={onPaste}
                   onPressEnter={onPasteEnter}
            />
            <br/>
            <Form.Item label={`${t("Selected Files")} ${fileList.length}`}>
                <div className={"app-drag-list"}
                     style={{
                         height: window.innerHeight - 440,
                     }}>
                    <List size={"small"}
                          dataSource={fileList}
                          style={{
                              height: window.innerHeight - 440,
                          }}
                          renderItem={item => (
                              <List.Item className={"app-drag-list-item"}>
                                  <Flex justify={"space-between"}
                                        gap={"small"}
                                        style={{width: "100%"}}
                                  >
                                      <Flex gap={"small"}>
                                          {
                                              item.type === "folder" ? (
                                                  item.isUnpackedMod ? <FolderOpenOutlined style={{color: '#52c41a'}}/> : <FolderOutlined/>
                                              ) :
                                              item.type === ".pak" ? <FilePptOutlined/> : <FileZipOutlined/>
                                          }
                                          <span>
                                              {item.name}
                                              {item.isUnpackedMod && <span style={{color: '#52c41a', marginLeft: 8, fontSize: 12}}>(Unpacked)</span>}
                                          </span>
                                      </Flex>
                                      <Button variant={"text"}
                                              size={"small"}
                                              color={"red"}
                                              icon={<CloseOutlined/>}
                                              onClick={() => onDeleteClick(item)}
                                      />
                                  </Flex>
                              </List.Item>
                          )}
                    />
                </div>
            </Form.Item>
        </Form>
    )

});

