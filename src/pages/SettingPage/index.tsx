import {BasePage} from "../IBasePage.ts";
import {MintCatSettings} from "@/pages/SettingPage/MintCatSettings.tsx";
import {NetworkSettings} from "@/pages/SettingPage/NetworkSettings.tsx";
import {CloudBackupSettings} from "@/pages/SettingPage/CloudBackupSettings.tsx";


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
                <NetworkSettings/>
                <CloudBackupSettings/>
            </div>
        );
    }
}
