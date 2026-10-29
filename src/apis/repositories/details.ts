/**
 * Post details (full text and files) for repository browse results, loaded lazily per
 * card with a small number of requests at a time and cached for the session.
 */
import {useEffect, useState} from "react";
import {RepositoryApi, type ModRepository, type RepositoryModDetail} from "./index";

const MAX_PARALLEL = 4;
const pending = new Map<string, Promise<RepositoryModDetail>>();
const loaded = new Map<string, RepositoryModDetail>();
const queue: (() => void)[] = [];
let running = 0;

function runLimited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            running++;
            task().then(resolve, reject).finally(() => {
                running--;
                queue.shift()?.();
            });
        };
        if (running < MAX_PARALLEL) start();
        else queue.push(start);
    });
}

function keyOf(baseUrl: string, slug: string): string {
    return `${baseUrl}|${slug}`;
}

export function loadRepositoryDetail(baseUrl: string, slug: string): Promise<RepositoryModDetail> {
    const key = keyOf(baseUrl, slug);
    const existing = pending.get(key);
    if (existing) return existing;
    const repo = {baseUrl} as ModRepository;
    const promise = runLimited(() => RepositoryApi.getMod(repo, slug));
    pending.set(key, promise);
    promise.then(
        (detail) => loaded.set(key, detail),
        () => pending.delete(key), // let a later card retry
    );
    return promise;
}

export function useRepositoryDetail(baseUrl?: string, slug?: string): RepositoryModDetail | undefined {
    const key = baseUrl && slug ? keyOf(baseUrl, slug) : "";
    const [detail, setDetail] = useState<RepositoryModDetail | undefined>(() => (key ? loaded.get(key) : undefined));
    useEffect(() => {
        if (!baseUrl || !slug) return;
        const cached = loaded.get(keyOf(baseUrl, slug));
        if (cached) {
            setDetail(cached);
            return;
        }
        let alive = true;
        loadRepositoryDetail(baseUrl, slug)
            .then((d) => alive && setDetail(d))
            .catch(() => {
                // the card keeps the short post title
            });
        return () => {
            alive = false;
        };
    }, [baseUrl, slug]);
    return detail;
}

/** "CustomColorEverything.pak" -> "CustomColorEverything"; several files -> "A, B +2" */
export function repositoryTitleFromFiles(detail: RepositoryModDetail | undefined): string | undefined {
    if (!detail) return undefined;
    const names: string[] = [];
    for (const file of detail.files) {
        if (!file.latest) continue;
        const stem = file.filename.replace(/\.(pak|zip)$/i, "");
        if (stem && !names.includes(stem)) names.push(stem);
    }
    if (names.length === 0) return undefined;
    const shown = names.slice(0, 2).join(", ");
    return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** The post's text as one paragraph (line breaks and repeated spaces collapsed) */
export function repositoryDescription(detail: RepositoryModDetail | undefined): string | undefined {
    const text = detail?.content?.replace(/\s+/g, " ").trim();
    return text || undefined;
}
