// CAPABILITY PLATFORM — shared contract (TASKS.md §1).
//
// A "capability" is one AI-native tool surface the IDE can host (the knowledge
// graph, the agent adapter, the governance broker, …). The point of this file is
// that the CHASSIS is generic: the frontend never knows what a capability *is*,
// only its declared state, its provider list, and which actions the backend says
// are available right now.
//
// ── HONESTY RULES (enforced by the backend registry) ───────────────────────
//  • `status` is always derived from evidence collected at detection time — a
//    binary on PATH, an artifact on disk, a live probe. There is no
//    "installed" flag anybody can set.
//  • A capability whose required tool is missing reports `tool-missing`, never
//    `not-installed` (that would imply the IDE can fix it locally).
//  • A capability the registry could not evaluate reports `unknown` with the
//    failure reason in `detail`. `unknown` is never rendered as healthy.
//  • Providers are DECLARED, not assumed: a Katsui-backed provider shows up
//    only on capabilities that actually declare one, and its `available` flag
//    stays false until a real connection exists. The IDE does not implement
//    Katsui products locally.

/** JSON-RPC path the capability registry is exposed on. */
export const CAPABILITY_SERVICE_PATH = '/services/capabilities';

/** DI symbol; merges with the interface below so the name serves as both. */
export const CapabilityService = Symbol('CapabilityService');

/**
 * Honest lifecycle state of one capability in one project.
 *
 *  ready         — evidence says it works here (artifact present / probe ok).
 *  degraded      — usable, but with declared limits (see `degradations`).
 *  not-installed — everything needed to install/generate it locally is present,
 *                  but the artifact/state it produces does not exist yet.
 *  tool-missing  — a required external tool is absent; the IDE cannot fix it.
 *  unavailable   — a live probe answered, and the answer was "no".
 *  unknown       — detection itself failed; the reason is in `detail`.
 */
export type CapabilityStatus =
    | 'ready'
    | 'degraded'
    | 'not-installed'
    | 'tool-missing'
    | 'unavailable'
    | 'unknown';

/** How the capability's own surface is opened, when it has one. */
export type CapabilitySurfaceKind = 'iframe' | 'none';

/** Kind of backing for a capability — where the work actually runs. */
export type CapabilityProviderKind = 'local' | 'katsui';

/**
 * One declared provider for a capability. `available` is evidence-based like
 * everything else: a declared-but-unconnected Katsui provider is
 * `available: false` with a `detail` saying what is missing.
 */
export interface CapabilityProvider {
    id: string;
    label: string;
    kind: CapabilityProviderKind;
    /** True only when this provider is actually usable right now. */
    available: boolean;
    /** True when this provider is the one currently serving the capability. */
    active: boolean;
    /** Honest reason when unavailable, or the connection requirement. */
    detail?: string;
}

/** The surface (if any) the capability renders into the work area. */
export interface CapabilitySurface {
    kind: CapabilitySurfaceKind;
    /**
     * Same-origin URL to embed. Carries a detection token so a freshly
     * generated artifact renders without a manual reload.
     */
    url?: string;
}

/** Full observable state of one capability in one project. */
export interface CapabilityState {
    id: string;
    label: string;
    /** One line: what this capability gives the project. */
    summary: string;
    status: CapabilityStatus;
    /** Honest human-readable reason for the current status. Never empty. */
    detail: string;
    /** Version of the backing tool, when detection could read one. */
    detectedVersion?: string;
    /**
     * True only when the backend has a real install/generate action AND its
     * preconditions hold. The frontend must not offer the action otherwise.
     */
    installable: boolean;
    /** Label for that action, e.g. "Gerar AAG". Present iff `installable`. */
    installLabel?: string;
    surface: CapabilitySurface;
    providers: CapabilityProvider[];
    /** Surfaces this capability does NOT enforce/cover — shown, not hidden. */
    degradations: string[];
    /** ISO timestamp of the detection this state came from. */
    detectedAt: string;
}

/**
 * Capability registry, proxied to the frontend over JSON-RPC.
 *
 * Every call re-detects from evidence; there is no cached "installed" bit and no
 * setter for `status`. `install` performs the capability's own real action (for
 * the graph: it runs the aag indexer) and then returns a freshly detected state.
 */
export interface CapabilityService {
    /** Detect every registered capability for this project root. */
    list(rootUri: string): Promise<CapabilityState[]>;

    /** Re-detect one capability. */
    detect(rootUri: string, id: string): Promise<CapabilityState>;

    /**
     * Run the capability's real install/generate action, then re-detect.
     * Rejects when the capability declares no action, or its preconditions
     * (e.g. the required tool) are not met.
     */
    install(rootUri: string, id: string): Promise<CapabilityState>;
}
