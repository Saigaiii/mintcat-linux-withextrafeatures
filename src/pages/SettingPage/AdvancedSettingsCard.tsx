import React from "react";
import {Card, Flex, Switch, Typography} from "antd";
import {t} from "i18next";
import {AdvancedSettings} from "@/services/AdvancedSettings";

export function useAdvancedShown(): boolean {
    React.useEffect(() => {
        void AdvancedSettings.load();
    }, []);
    return React.useSyncExternalStore(AdvancedSettings.subscribe, AdvancedSettings.isShown);
}

export function AdvancedSettingsCard() {
    const shown = useAdvancedShown();
    return (
        <Card title={t("advanced.title")} style={{marginBottom: "10px"}}>
            <Flex gap={12} align="center">
                <Switch checked={shown} onChange={(checked) => void AdvancedSettings.setShown(checked)}/>
                <Typography.Text>{t("advanced.show")}</Typography.Text>
            </Flex>
            <Typography.Paragraph type="secondary" style={{marginTop: 8, marginBottom: 0}}>
                {t("advanced.hint")}
            </Typography.Paragraph>
        </Card>
    );
}
