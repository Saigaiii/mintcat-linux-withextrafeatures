import React from "react";
import {BasePage} from "../IBasePage.ts";
import {MintCatSettings} from "@/pages/SettingPage/MintCatSettings.tsx";
import {NetworkSettings} from "@/pages/SettingPage/NetworkSettings.tsx";
import {CloudBackupSettings} from "@/pages/SettingPage/CloudBackupSettings.tsx";
import {BackupSettings} from "@/pages/SettingPage/BackupSettings.tsx";
import {AdvancedSettingsCard, useAdvancedShown} from "@/pages/SettingPage/AdvancedSettingsCard.tsx";

/** Network settings and the MINTCAT supporters' cloud backup only show with "Show advanced settings" */
function AdvancedOnly({children}: { children: React.ReactNode }) {
    return useAdvancedShown() ? <>{children}</> : null;
}


export class SettingPage extends BasePage<any, any> {

    public constructor(props: any) {
        super(props);
    }

    componentDidMount(): void {
        this.hookWindowResized();
        this.hookLogPanel();
    }

    componentWillUnmount(): void {
        this.unhookLogPanel();
        this.unhookWindowResized();
    }

    render() {
        return (
            <div
                id="scrollableDiv"
                className="scrollable-div"
                style={{ height: window.innerHeight - 81 - this.logPanelOffset }}>
                <MintCatSettings/>
                <BackupSettings/>
                <AdvancedOnly>
                    <NetworkSettings/>
                    <CloudBackupSettings/>
                </AdvancedOnly>
                <AdvancedSettingsCard/>
            </div>
        );
    }
}
