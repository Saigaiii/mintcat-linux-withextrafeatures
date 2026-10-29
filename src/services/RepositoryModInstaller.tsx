/**
 * Add a mod from a user-added repository: pick its file(s), download them into
 * MintCat's own data folder, then open Add Mod (Local tab) with the downloaded files.
 */
import React, {useState} from "react";
import {t} from "i18next";
import {Checkbox, Flex, message, Tag, Typography} from "antd";
import {appDataDir, join} from "@tauri-apps/api/path";
import {mkdir} from "@tauri-apps/plugin-fs";
import {RepositoryApi, RepositoryFile, RepositoryStore, safeModFileName} from "@/apis/repositories";
import type {RepositoryResultData, SearchResultItem} from "@/apis/search";
import {DownloadApi} from "@/apis/DownloadApi";
import {MessageBox} from "@/components/MessageBox";
import StatusBar from "@/components/StatusBar";
import {logActivity} from "@/services/ActivityLog";
import {RepositoryUpdates} from "@/services/RepositoryUpdates";
import {openWindow} from "@/dialogs/AddModDialog/open";
import {AddModType} from "@/dialogs/AddModDialog";

function formatSize(bytes: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

function FileChooser({files, initial, onChange}: {
    files: RepositoryFile[];
    initial: number[];
    onChange: (indexes: number[]) => void;
}) {
    const [selected, setSelected] = useState<number[]>(initial);
    const update = (next: number[]) => {
        setSelected(next);
        onChange(next);
    };
    return (
        <Flex vertical gap={6} style={{maxHeight: 320, overflowY: "auto", marginTop: 8}}>
            <Typography.Text type="secondary" style={{fontSize: 12}}>{t("repo.chooseFilesHint")}</Typography.Text>
            {files.map((file, index) => (
                <Checkbox key={index}
                          checked={selected.includes(index)}
                          onChange={(e) => update(e.target.checked
                              ? [...selected, index]
                              : selected.filter(i => i !== index))}>
                    <span style={{wordBreak: "break-all"}}>{file.filename}</span>
                    {file.latest
                        ? <Tag color="green" style={{marginInlineStart: 6}}>{t("repo.latest")}</Tag>
                        : <Tag style={{marginInlineStart: 6}}>{t("repo.olderUpload")}</Tag>}
                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                        {[formatSize(file.sizeBytes), formatDate(file.postedAt), file.fromThread ? t("repo.inThread") : ""]
                            .filter(Boolean).join(" · ")}
                    </Typography.Text>
                </Checkbox>
            ))}
        </Flex>
    );
}

async function chooseFiles(modName: string, files: RepositoryFile[]): Promise<RepositoryFile[] | null> {
    const initial = files.map((f, i) => (f.latest ? i : -1)).filter(i => i >= 0);
    // Only a single file needs no question (several files are often alternative variants)
    if (files.length === 1) {
        return [files[0]];
    }
    let selection = initial;
    const ok = await MessageBox.confirm({
        title: t("repo.chooseFiles", {name: modName}),
        icon: null,
        width: 560,
        okText: t("repo.downloadAndAdd"),
        content: <FileChooser files={files} initial={initial} onChange={(s) => (selection = s)}/>,
    });
    if (!ok) return null;
    return selection.sort((a, b) => a - b).map(i => files[i]);
}

export async function addRepositoryMod(item: SearchResultItem): Promise<void> {
    const raw = item.rawData as RepositoryResultData | undefined;
    const repo = raw ? await RepositoryStore.get(raw.repositoryId) : undefined;
    if (!raw || !repo) {
        message.error(t("repo.notFound"));
        return;
    }

    let detail;
    try {
        detail = await RepositoryApi.getMod(repo, raw.slug);
    } catch (error) {
        await logActivity('error', t("repo.loadPostFailed", {name: item.name, reason: String(error)}), item.profileUrl, 'repository');
        message.error(t("repo.loadPostFailed", {name: item.name, reason: String(error)}));
        return;
    }

    const files = detail.files.filter(f => safeModFileName(f.filename));
    if (files.length === 0) {
        await logActivity('error', t("repo.noModFiles", {name: item.name}), item.profileUrl, 'repository');
        message.error(t("repo.noModFiles", {name: item.name}));
        return;
    }

    const chosen = await chooseFiles(item.name, files);
    if (!chosen || chosen.length === 0) {
        return;
    }

    // ~/.local/share/com.mint.cat/repository-mods/<repo>/<post>/<file>
    const baseDir = await join(await appDataDir(), "repository-mods", repo.id, raw.slug);
    const usedNames = new Map<string, number>();
    const downloaded: string[] = [];

    for (const file of chosen) {
        const name = safeModFileName(file.filename)!;
        const count = usedNames.get(name.toLowerCase()) ?? 0;
        usedNames.set(name.toLowerCase(), count + 1);
        // Two uploads with the same name (e.g. an older version too) go in separate folders
        const dir = count === 0 ? baseDir : await join(baseDir, `older-${count}`);
        try {
            await mkdir(dir, {recursive: true});
            const target = await join(dir, name);
            await StatusBar.info(t("repo.downloading", {name}));
            await DownloadApi.downloadFile(file.downloadUrl, target, {resume: false, retryCount: 2});
            downloaded.push(target);
            // So the Update button can find newer uploads of this file later
            await RepositoryUpdates.rememberDownloadedFile(target, {
                repoId: repo.id,
                slug: raw.slug,
                filename: file.filename,
                postedAt: file.postedAt,
                sizeBytes: file.sizeBytes,
                via: 'added',
            });
            await logActivity('success', t("repo.downloaded", {name, repo: repo.name}), file.downloadUrl, 'repository');
        } catch (error) {
            await logActivity('error', t("repo.downloadFailed", {name, reason: String(error)}), file.downloadUrl, 'repository');
            message.error(t("repo.downloadFailed", {name, reason: String(error)}));
        }
    }

    if (downloaded.length > 0) {
        await StatusBar.success(t("repo.downloadDone", {count: downloaded.length}));
        await openWindow(AddModType.LOCAL, 0, "", undefined, downloaded);
    }
}
