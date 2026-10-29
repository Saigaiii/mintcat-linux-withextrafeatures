import React from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {ActivityLog} from "@/services/ActivityLog";

export abstract class BasePage<P, S> extends React.Component<P, S> {
    private isHooked: boolean = false;
    private unsubscribeLogPanel?: () => void;

    protected hookWindowResized() {
        try {
            if (this.isHooked) {
                return;
            }
            this.isHooked = true;
            getCurrentWindow().onResized(({payload: size}) => {
                this.forceUpdate();
            }).then(_ => {
            });
        } catch (e) {

        }
    }

    /** Re-render when the bottom Log panel opens/closes (it takes height from the page) */
    protected hookLogPanel() {
        if (this.unsubscribeLogPanel) {
            return;
        }
        this.unsubscribeLogPanel = ActivityLog.subscribeOpen(() => this.forceUpdate());
    }

    protected unhookLogPanel() {
        this.unsubscribeLogPanel?.();
        this.unsubscribeLogPanel = undefined;
    }

    /** Height taken by the open Log panel */
    protected get logPanelOffset(): number {
        return ActivityLog.getPanelOffset();
    }
}
