import React, {useEffect, useState} from "react";
import {t} from "i18next";
import {Button, Empty, Flex, Input, List, message, Modal, Select, Typography} from "antd";
import {DeleteOutlined, PlusOutlined} from "@ant-design/icons";
import {ModRepository, RepositoryGame, RepositoryStore} from "@/apis/repositories";
import {logActivity} from "@/services/ActivityLog";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Called after a repository was added or removed */
    onChanged: (added?: ModRepository) => void;
}

function addErrorText(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'duplicate') return t("repo.errorDuplicate");
    if (msg === 'empty' || msg === 'protocol' || msg.includes('Invalid URL')) return t("repo.errorBadUrl");
    if (msg === 'not-a-repository' || msg.includes('did not return JSON')) return t("repo.errorNotRepository");
    return t("repo.errorUnreachable", {reason: msg});
}

export function RepositoryManagerDialog({open, onClose, onChanged}: Props) {
    const [repos, setRepos] = useState<ModRepository[]>([]);
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [game, setGame] = useState<RepositoryGame>('drg');
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        RepositoryStore.list().then(list => setRepos([...list]));
        return RepositoryStore.subscribe(() => RepositoryStore.list().then(list => setRepos([...list])));
    }, [open]);

    const onAdd = async () => {
        setError("");
        setAdding(true);
        try {
            const repo = await RepositoryStore.add({name, url, game});
            message.success(t("repo.added", {name: repo.name}));
            await logActivity('success', t("repo.added", {name: repo.name}), repo.baseUrl, 'repository');
            setName("");
            setUrl("");
            onChanged(repo);
        } catch (e) {
            setError(addErrorText(e));
        } finally {
            setAdding(false);
        }
    };

    const onRemove = async (repo: ModRepository) => {
        await RepositoryStore.remove(repo.id);
        await logActivity('info', t("repo.removed", {name: repo.name}), repo.baseUrl, 'repository');
        onChanged();
    };

    return (
        <Modal open={open}
               title={t("repo.manageTitle")}
               onCancel={onClose}
               footer={<Button onClick={onClose}>{t("log.close")}</Button>}
               width={560}
               destroyOnHidden>
            <Typography.Paragraph type="secondary" style={{fontSize: 13}}>
                {t("repo.manageHint")}
            </Typography.Paragraph>

            {repos.length === 0
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("repo.none")} style={{margin: "8px 0"}}/>
                : <List size="small"
                        bordered
                        dataSource={repos}
                        renderItem={(repo) => (
                            <List.Item actions={[
                                <Button key="remove" size="small" type="text" danger icon={<DeleteOutlined/>}
                                        onClick={() => onRemove(repo)}>{t("repo.remove")}</Button>
                            ]}>
                                <Flex vertical>
                                    <Typography.Text strong>{repo.name}</Typography.Text>
                                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                                        {repo.baseUrl} · {repo.game === 'rc' ? 'Rogue Core' : 'Deep Rock Galactic'}
                                    </Typography.Text>
                                </Flex>
                            </List.Item>
                        )}/>}

            <Typography.Title level={5} style={{marginTop: 16}}>{t("repo.addTitle")}</Typography.Title>
            <Flex vertical gap={8}>
                <Input placeholder={t("repo.namePlaceholder")}
                       value={name}
                       onChange={(e) => setName(e.target.value)}/>
                <Input placeholder="https://pak-hub.pages.dev"
                       value={url}
                       onChange={(e) => setUrl(e.target.value)}
                       onPressEnter={onAdd}/>
                <Flex gap={8}>
                    <Select value={game}
                            onChange={setGame}
                            style={{flex: 1}}
                            options={[
                                {value: 'drg', label: 'Deep Rock Galactic'},
                                {value: 'rc', label: 'Rogue Core'},
                            ]}/>
                    <Button type="primary"
                            icon={<PlusOutlined/>}
                            loading={adding}
                            disabled={!url.trim()}
                            onClick={onAdd}>
                        {t("repo.add")}
                    </Button>
                </Flex>
                {error && <Typography.Text type="danger">{error}</Typography.Text>}
            </Flex>
        </Modal>
    );
}
