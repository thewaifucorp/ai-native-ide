// HARNESS PROVIDER — shared contract (TASKS.md §1).
//
// A *harness* is the opinionated work method a project runs under (GSD, Scrum,
// a house process, …). The IDE does not implement any of them: it defines this
// contract and hosts whoever claims it. A provider ships a VERSIONED MANIFEST
// and claims slots.
//
// ── SLOTS ARE EXCLUSIVE, PER PROJECT ──────────────────────────────────────
// Exactly one provider may own each of `workflow`, `work-hierarchy` and
// `primary-status` in a given project. A second provider claiming an owned slot
// is REJECTED with a named conflict — the IDE never silently merges two
// workflows, two hierarchies or two primary statuses.
//
// ── EXTENSIONS ARE COMPOSABLE ─────────────────────────────────────────────
// `checks`, `packs`, `importers` and `views` are additive: any number of active
// providers contribute them, and they are attributed to their provider.
//
// ── STATE SURVIVES LIFECYCLE ──────────────────────────────────────────────
// `activate` / `suspend` / `migrate` never destroy provider state. Suspending
// frees the slots and keeps the items; re-activating restores the same items;
// migrating to a new manifest version keeps the items and records which version
// wrote them.
//
// ── EVERYTHING IS AN ARTIFACT ─────────────────────────────────────────────
// A provider is NOT code compiled into the IDE. It is a manifest FILE in the
// project (`.harness/providers/<id>.json` — committed, reviewable in a diff) and
// a directory of work-item FILES that the manifest declares. The registry
// discovers whatever is on disk.
//
// That is what makes the contract usable by an agent: writing a provider means
// writing a JSON file, and creating work means writing a markdown file — both
// reviewable in a diff, both surviving a reinstall of the IDE. `register` exists
// for convenience (it writes the manifest for you), never as the only door.
//
// ── NO BYPASS ─────────────────────────────────────────────────────────────
// This API deliberately exposes NO way for a provider to touch workspace files.
// The single outward path is `providerEffect`, which goes through the governed
// write service — i.e. the real Rust broker: capability registry, approval gate,
// snapshot, rollback, and the activity trail that serves as the receipt. A
// provider effect therefore always comes back `awaiting`: nothing is written
// until a human approves it.

import { WriteProposal } from './governed-protocol';

/** JSON-RPC path the harness registry is exposed on. */
export const HARNESS_SERVICE_PATH = '/services/harness';

/** DI symbol; merges with the interface below so the name serves as both. */
export const HarnessService = Symbol('HarnessService');

/** The three exclusive, single-owner slots of a project's harness. */
export type HarnessSlot = 'workflow' | 'work-hierarchy' | 'primary-status';

export const HARNESS_SLOTS: HarnessSlot[] = ['workflow', 'work-hierarchy', 'primary-status'];

/** Version of the manifest FORMAT this IDE understands. */
export const HARNESS_MANIFEST_VERSION = 1;

/** Where a provider keeps the artifacts it owns, relative to the project root. */
export interface HarnessArtifacts {
    /** Directory holding this provider's work-item files. */
    itemsDir: string;
    /** Extension of one work-item artifact (e.g. `.md`). */
    itemExtension: string;
}

/** Additive contributions — any number of providers may supply these. */
export interface HarnessExtensions {
    checks: string[];
    packs: string[];
    importers: string[];
    views: string[];
}

/** A provider's versioned declaration of what it takes over and what it adds. */
export interface HarnessManifest {
    id: string;
    label: string;
    /** Provider's own version. `migrate` moves state between these. */
    version: string;
    /** Manifest FORMAT version; must equal HARNESS_MANIFEST_VERSION. */
    manifestVersion: number;
    /** Exclusive slots this provider wants to own. */
    claims: HarnessSlot[];
    extensions: HarnessExtensions;
    /** Artifacts this provider owns on disk (CAP-01). */
    artifacts: HarnessArtifacts;
    /** What the provider claims to cover — rendered as declared, not as proof. */
    coverage?: string[];
    /** What it explicitly does NOT cover. Shown, never hidden (CAP-01). */
    limitations?: string[];
    /** Provider versions this manifest can take over state from (CAP-03). */
    migratesFrom?: string[];
    /** Shape of the claimed slots — declared, so the IDE can render them. */
    workflow?: { states: string[]; initial: string };
    hierarchy?: { levels: string[] };
    primaryStatus?: { label: string; values: string[] };
}

/** Where a registered provider is in its lifecycle. */
export type HarnessProviderStatus = 'registered' | 'active' | 'suspended';

/** One work item, as it exists on disk. */
export interface HarnessItem {
    /** File name without extension — the item's stable id. */
    id: string;
    /** Path relative to the project root, so an agent can open/edit it. */
    path: string;
    /** First heading/line of the artifact, when readable. */
    title: string;
}

/** A discovered provider plus the state the registry preserves for it. */
export interface HarnessProviderState {
    manifest: HarnessManifest;
    status: HarnessProviderStatus;
    /** Work-item artifacts found in the directory the manifest declares. */
    items: HarnessItem[];
    /** Manifest version that last wrote this state (updated by `migrate`). */
    stateVersion: string;
    /** Path of the manifest artifact itself, relative to the project root. */
    manifestPath: string;
}

/** Current owner of one exclusive slot (`providerId` absent = free). */
export interface HarnessBinding {
    slot: HarnessSlot;
    providerId?: string;
}

/** One entry of the harness receipt trail (append-only, honest). */
export interface HarnessReceipt {
    at: string;
    providerId: string;
    action: 'register' | 'activate' | 'suspend' | 'migrate' | 'effect-proposed';
    detail: string;
}

/** Everything the frontend renders for the harness of one project. */
export interface HarnessSnapshot {
    providers: HarnessProviderState[];
    bindings: HarnessBinding[];
    /** Composed extensions, attributed to the active provider that gave them. */
    composedExtensions: { providerId: string; kind: keyof HarnessExtensions; name: string }[];
    receipts: HarnessReceipt[];
}

/**
 * Result of routing a provider effect through the broker: the awaiting governed
 * proposal itself, so the human resolves it on the SAME dock decision card as
 * any other write. `state` is always 'awaiting' — the provider cannot write.
 */
export interface HarnessEffectResult {
    proposal: WriteProposal;
}

/**
 * Harness provider registry for one project root.
 *
 * The IDE ships this contract and one test provider (see
 * `harness-test-provider.ts`) that exercises it end to end. No real method
 * (GSD, Scrum, …) is implemented here.
 */
export interface HarnessService {
    /** Current providers, slot bindings, composed extensions and receipts. */
    snapshot(rootUri: string): Promise<HarnessSnapshot>;

    /**
     * Write a provider manifest artifact (and create its items directory). A
     * convenience door: dropping the same JSON in `.harness/providers/<id>.json`
     * by hand — or from an agent — is equivalent, and `snapshot` discovers it
     * either way. Does not activate.
     */
    register(rootUri: string, manifest: HarnessManifest): Promise<HarnessSnapshot>;

    /** Take the claimed slots. Rejects on any slot already owned. */
    activate(rootUri: string, providerId: string): Promise<HarnessSnapshot>;

    /** Free the slots, keep the provider's items. */
    suspend(rootUri: string, providerId: string): Promise<HarnessSnapshot>;

    /** Move a provider to a new manifest version, preserving its items. */
    migrate(rootUri: string, providerId: string, manifest: HarnessManifest): Promise<HarnessSnapshot>;

    /**
     * Create work-item artifacts for a provider — one file per title, in the
     * directory its manifest declares. Writing those files directly (an agent
     * doing its job) has exactly the same effect.
     */
    addItems(rootUri: string, providerId: string, items: string[]): Promise<HarnessSnapshot>;

    /**
     * The ONLY outward path: propose a workspace write on the provider's
     * behalf, through the governed broker. Returns an awaiting proposal —
     * never a completed write.
     */
    providerEffect(
        rootUri: string,
        providerId: string,
        relPath: string,
        content: string
    ): Promise<HarnessEffectResult>;
}
