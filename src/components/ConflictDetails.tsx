import React, {useEffect, useState} from "react";
import {t} from "i18next";
import {Collapse, Empty, Flex, Spin, Tag, Typography} from "antd";
import {ConflictPair, ConflictService} from "@/services/ConflictService";
import {IoC} from "@/core/IoC.ts";
import {ProfileViewModel} from "@/dialogs/ProfileEditDialog/ProfileViewModel";
import {flattenTreeModIds} from "@/utils/ModDisplayOrder";

/**
 * Current install order, read fresh so winners stay right after reordering
 * (the conflict check itself only needs re-running when mods are added/removed/updated).
 */
async function loadInstallOrder(): Promise<number[]> {
    const profileVM = await IoC.get(ProfileViewModel);
    return flattenTreeModIds(await profileVM.getActiveProfileTreeRoot());
}

function usePairs(focusModId?: number): { pairs: ConflictPair[] | null; order: number[] } {
    const [state, setState] = useState<{ pairs: ConflictPair[] | null; order: number[] }>({pairs: null, order: []});
    useEffect(() => {
        let cancelled = false;
        loadInstallOrder()
            .catch(() => [] as number[])
            .then(order => {
                if (!cancelled) {
                    setState({pairs: ConflictService.getPairs(order, focusModId), order});
                }
            });
        return () => {
            cancelled = true;
        };
    }, [focusModId]);
    return state;
}

function AssetList({pair}: { pair: ConflictPair }) {
    return (
        <div style={{maxHeight: 220, overflowY: "auto", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6}}>
            {pair.assets.map(asset => (
                <div key={asset.path} style={{wordBreak: "break-all"}}>
                    {asset.path}
                    {asset.extensions.length > 0 &&
                        <Typography.Text type="secondary" style={{fontSize: 11}}>
                            {" "}{asset.extensions.join(" ")}
                        </Typography.Text>}
                </div>
            ))}
        </div>
    );
}

function positionLabel(order: number[], modId: number): string {
    const index = order.indexOf(modId);
    return index >= 0 ? `#${index + 1}` : "";
}

function AudioNote() {
    return (
        <Tag color="orange" style={{marginInlineEnd: 0}}>
            {t("conflict.audioUncertain")}
        </Tag>
    );
}

function OrderHint() {
    return (
        <Typography.Text type="secondary" style={{fontSize: 12}}>
            {t("conflict.orderHint")}
        </Typography.Text>
    );
}

/**
 * Conflicts of a single mod, from that mod's point of view.
 */
export function ModConflictDetails({modId}: { modId: number }) {
    const {pairs, order} = usePairs(modId);

    if (pairs === null) {
        return <Spin size="small"/>;
    }
    if (pairs.length === 0) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No conflicts detected")}/>;
    }

    const items = pairs.map(pair => {
        const otherId = pair.winnerId === modId ? pair.loserId : pair.winnerId;
        const thisWins = pair.winnerId === modId;
        return {
            key: `${pair.winnerId}:${pair.loserId}`,
            label: (
                <Flex gap={6} wrap align="center">
                    <Typography.Text strong>{ConflictService.getModName(otherId)}</Typography.Text>
                    <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, otherId)}</Typography.Text>
                    {pair.orderUncertain
                        ? <AudioNote/>
                        : thisWins
                            ? <Tag color="green" style={{marginInlineEnd: 0}}>{t("conflict.thisWins")}</Tag>
                            : <Tag color="red" style={{marginInlineEnd: 0}}>{t("conflict.thisLoses")}</Tag>}
                    <Typography.Text type="secondary" style={{fontSize: 12}}>
                        {t("conflict.assetCount", {count: pair.assets.length})}
                    </Typography.Text>
                </Flex>
            ),
            children: <AssetList pair={pair}/>,
        };
    });

    return (
        <Flex vertical gap={8} style={{width: 460, maxWidth: "80vw"}}>
            <Typography.Text>
                {ConflictService.getModName(modId)}
                <Typography.Text type="secondary"> {positionLabel(order, modId)}</Typography.Text>
            </Typography.Text>
            <div style={{maxHeight: 360, overflowY: "auto"}}>
                <Collapse size="small" items={items}/>
            </div>
            <OrderHint/>
        </Flex>
    );
}

/**
 * Every conflicting pair in the profile, winner first.
 */
export function ConflictReport() {
    const {pairs, order} = usePairs();

    if (pairs === null) {
        return <Spin/>;
    }
    if (pairs.length === 0) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No conflicts detected")}/>;
    }

    const items = pairs.map(pair => ({
        key: `${pair.winnerId}:${pair.loserId}`,
        label: (
            <Flex gap={6} wrap align="center">
                <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, pair.winnerId)}</Typography.Text>
                <Typography.Text strong>{ConflictService.getModName(pair.winnerId)}</Typography.Text>
                <Typography.Text type="secondary">{pair.orderUncertain ? "⇄" : t("conflict.overrides")}</Typography.Text>
                <Typography.Text type="secondary" style={{fontSize: 12}}>{positionLabel(order, pair.loserId)}</Typography.Text>
                <Typography.Text strong>{ConflictService.getModName(pair.loserId)}</Typography.Text>
                {pair.orderUncertain && <AudioNote/>}
                <Typography.Text type="secondary" style={{fontSize: 12}}>
                    {t("conflict.assetCount", {count: pair.assets.length})}
                </Typography.Text>
            </Flex>
        ),
        children: <AssetList pair={pair}/>,
    }));

    const modCount = new Set(pairs.flatMap(p => [p.winnerId, p.loserId])).size;

    return (
        <Flex vertical gap={8}>
            <Typography.Text>
                {t("conflict.reportSummary", {pairs: pairs.length, mods: modCount})}
            </Typography.Text>
            <div style={{maxHeight: "60vh", overflowY: "auto"}}>
                <Collapse size="small" items={items}/>
            </div>
            <OrderHint/>
        </Flex>
    );
}
