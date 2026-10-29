import React, {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {t} from "i18next";
import {Button, Flex, message, theme, Tooltip} from "antd";
import {ClearOutlined, CloseOutlined, CopyOutlined, FolderOpenOutlined} from "@ant-design/icons";
import {appLogDir} from "@tauri-apps/api/path";
import {openPath} from "@tauri-apps/plugin-opener";
import {ActivityEntry, ActivityLevel, ActivityLog, formatLogTime, LOG_PANEL_HEIGHT} from "@/services/ActivityLog";

/**
 * Log state for components. Values come from the store's snapshot (a new object on every
 * change) rather than direct store calls, which the React Compiler would cache forever.
 */
export function useActivityLog() {
    const snap = useSyncExternalStore(ActivityLog.subscribe, ActivityLog.getSnapshot);
    return {
        version: snap,
        entries: snap.entries,
        open: snap.open,
        unseenProblems: snap.unseenProblems,
    };
}

/** Height the open panel takes away from page content (re-renders only on open/close) */
export function useLogPanelOffset(): number {
    return useSyncExternalStore(
        (cb) => ActivityLog.subscribeOpen(cb),
        () => ActivityLog.getPanelOffset()
    );
}

function EntryLine({entry, colors}: { entry: ActivityEntry; colors: Record<ActivityLevel, string | undefined> }) {
    const prefix = entry.level === 'error' ? 'ERROR: ' : entry.level === 'warning' ? 'WARN: ' : '';
    return (
        <div style={{color: colors[entry.level], whiteSpace: "pre-wrap", wordBreak: "break-word"}}>
            [{formatLogTime(entry.time)}] [{entry.source}] {prefix}{entry.message}
            {entry.detail && <span style={{opacity: 0.75}}>{"  "}{entry.detail}</span>}
        </div>
    );
}

/** "● Errors" style filter toggle */
function DotToggle({label, color, count, active, onClick}: {
    label: string; color: string; count: number; active: boolean; onClick: () => void;
}) {
    return (
        <Button size="small" type={active ? "default" : "text"} onClick={onClick}>
            <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: 4,
                background: color, marginRight: 4, verticalAlign: "middle"
            }}/>
            {label}{count > 0 ? ` (${count})` : ""}
        </Button>
    );
}

/**
 * Bottom log panel (docked above the status bar), styled after Amethyst's log
 */
export function LogPanel() {
    const {token} = theme.useToken();
    const {entries, open, version} = useActivityLog();
    const [showErrors, setShowErrors] = useState(false);
    const [showWarnings, setShowWarnings] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const stickToBottom = useRef(true);

    const colors: Record<ActivityLevel, string | undefined> = {
        info: undefined,
        success: token.colorSuccess,
        warning: token.colorWarning,
        error: token.colorError,
    };

    const errorCount = entries.filter(e => e.level === 'error').length;
    const warningCount = entries.filter(e => e.level === 'warning').length;
    // Neither toggle on = everything; otherwise only the toggled levels
    const visible = (showErrors || showWarnings)
        ? entries.filter(e => (showErrors && e.level === 'error') || (showWarnings && e.level === 'warning'))
        : entries;

    useEffect(() => {
        const el = bodyRef.current;
        if (el && stickToBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [version, showErrors, showWarnings, open]);

    if (!open) {
        return null;
    }

    const onScroll = () => {
        const el = bodyRef.current;
        if (el) {
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
    };

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(ActivityLog.asText());
            message.success(t("log.copied"));
        } catch {
            message.error(t("log.copyFailed"));
        }
    };

    const onOpenFolder = async () => {
        try {
            await openPath(await appLogDir());
        } catch (e) {
            message.error(`${t("log.openFolderFailed")}: ${e}`);
        }
    };

    return (
        <div className="log-panel" style={{
            height: LOG_PANEL_HEIGHT,
            display: "flex",
            flexDirection: "column",
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            position: "relative",
            zIndex: 5,
        }}>
            <div ref={bodyRef}
                 onScroll={onScroll}
                 style={{
                     flex: 1,
                     overflowY: "auto",
                     padding: "4px 8px",
                     fontFamily: "ui-monospace, 'DejaVu Sans Mono', 'Noto Sans Mono', monospace",
                     fontSize: 12,
                     lineHeight: 1.45,
                 }}>
                {visible.length === 0
                    ? <div style={{opacity: 0.6}}>
                        {t((showErrors || showWarnings) ? "log.noProblems" : "log.empty")}
                    </div>
                    : visible.map(entry => <EntryLine key={entry.id} entry={entry} colors={colors}/>)}
            </div>
            <Flex align="center" gap={2} style={{padding: "2px 6px", borderTop: `1px solid ${token.colorBorderSecondary}`}}>
                <DotToggle label={t("log.errors")} color={token.colorError} count={errorCount}
                           active={showErrors} onClick={() => setShowErrors(!showErrors)}/>
                <DotToggle label={t("log.warnings")} color={token.colorWarning} count={warningCount}
                           active={showWarnings} onClick={() => setShowWarnings(!showWarnings)}/>
                <Button size="small" type="text" icon={<CopyOutlined/>} onClick={onCopy}>{t("log.copy")}</Button>
                <Button size="small" type="text" icon={<ClearOutlined/>} onClick={() => ActivityLog.clear()}>{t("log.clear")}</Button>
                <Button size="small" type="text" icon={<FolderOpenOutlined/>} onClick={onOpenFolder}>{t("log.openFolder")}</Button>
                <span style={{flex: 1}}/>
                <Tooltip title={t("log.close")}>
                    <Button size="small" type="text" icon={<CloseOutlined/>} onClick={() => ActivityLog.setOpen(false)}/>
                </Tooltip>
            </Flex>
        </div>
    );
}

/**
 * Toggle button for the status bar; shows a count of new problems while closed
 */
export function LogToggleButton() {
    const {open, unseenProblems} = useActivityLog();
    const {token} = theme.useToken();
    return (
        <Button size="small"
                type={open ? "default" : "text"}
                onClick={() => ActivityLog.toggle()}
                style={{marginLeft: 6}}>
            {t("log.title")}
            {!open && unseenProblems > 0 &&
                <span style={{
                    marginLeft: 6,
                    background: token.colorError,
                    color: "#fff",
                    borderRadius: 8,
                    padding: "0 6px",
                    fontSize: 11,
                    lineHeight: "16px",
                }}>{unseenProblems}</span>}
        </Button>
    );
}

export default React.memo(LogPanel);
