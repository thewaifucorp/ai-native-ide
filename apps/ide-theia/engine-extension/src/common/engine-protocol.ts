// Shared contract between the Theia frontend proxy and the backend service.
// Both sides import ENGINE_SERVICE_PATH + the EngineService type from here.

/** JSON-RPC path the backend service is exposed on and the frontend proxies to. */
export const ENGINE_SERVICE_PATH = '/services/engine-diff';

/** DI symbol; merges with the interface below so the name serves as both. */
export const EngineService = Symbol('EngineService');

/** Mirrors `ide_diff::LineTag` (serde `snake_case`). */
export type LineTag = 'context' | 'added' | 'removed';

/** Mirrors `ide_diff::DiffLine` (serde `camelCase`). */
export interface DiffLine {
    tag: LineTag;
    text: string;
}

/** Mirrors `ide_diff::Hunk` (serde `camelCase`). */
export interface Hunk {
    id: number;
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
}

/**
 * Backend service proxied to the frontend over JSON-RPC. Every call is served
 * by the real Rust `ide-diff` engine running in the sidecar child process.
 */
export interface EngineService {
    /** Health check — confirms the Rust sidecar spawned and is responding. */
    ping(): Promise<{ pong: boolean; engine: string }>;

    /** Real `ide_diff::diff` — line-level hunks between original and proposed. */
    diff(original: string, proposed: string): Promise<Hunk[]>;

    /** Real `ide_diff::merge_selected` — rebuild content applying only the given hunk ids. */
    mergeSelected(original: string, proposed: string, selected: number[]): Promise<string>;
}
