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
    /** Shape of the claimed slots — declared, so the IDE can render them. */
    workflow?: { states: string[]; initial: string };
    hierarchy?: { levels: string[] };
    primaryStatus?: { label: string; values: string[] };
}

/** Where a registered provider is in its lifecycle. */
export type HarnessProviderStatus = 'registered' | 'active' | 'suspended';

/** A registered provider plus the state the registry preserves for it. */
export interface HarnessProviderState {
    manifest: HarnessManifest;
    status: HarnessProviderStatus;
    /** Provider-owned work items the registry persists across the lifecycle. */
    items: string[];
    /** Manifest version that last wrote this state (updated by `migrate`). */
    stateVersion: string;
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

    /** Register (or re-register) a provider manifest. Does not activate it. */
    register(rootUri: string, manifest: HarnessManifest): Promise<HarnessSnapshot>;

    /** Take the claimed slots. Rejects on any slot already owned. */
    activate(rootUri: string, providerId: string): Promise<HarnessSnapshot>;

    /** Free the slots, keep the provider's items. */
    suspend(rootUri: string, providerId: string): Promise<HarnessSnapshot>;

    /** Move a provider to a new manifest version, preserving its items. */
    migrate(rootUri: string, providerId: string, manifest: HarnessManifest): Promise<HarnessSnapshot>;

    /** Add provider-owned work items (the state the lifecycle must preserve). */
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
