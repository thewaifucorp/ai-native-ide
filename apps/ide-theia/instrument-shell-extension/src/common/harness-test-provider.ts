// The IDE's own PROOF provider for the harness contract.
//
// It is not a work method — it is the minimal real thing that exercises every
// clause of common/harness-protocol.ts: a versioned manifest, exclusive slot
// claims, composable extensions, and a v2 the registry can migrate to while the
// provider's items survive. GSD (or Scrum, or a house process) would ship its
// own manifest exactly like this one; none is implemented here.
//
// `CONFLICT_PROVIDER` exists to prove the exclusivity gate is real: it claims
// `workflow` only, so activating it while the test provider holds that slot must
// be REJECTED, not merged.

import { HarnessManifest } from './harness-protocol';

export const TEST_PROVIDER_ID = 'harness-test';
export const CONFLICT_PROVIDER_ID = 'harness-conflict';

/** v1 — claims all three exclusive slots and contributes one of each extension. */
export const TEST_PROVIDER_V1: HarnessManifest = {
    id: TEST_PROVIDER_ID,
    label: 'Harness de prova (v1)',
    version: '1.0.0',
    manifestVersion: 1,
    claims: ['workflow', 'work-hierarchy', 'primary-status'],
    extensions: {
        checks: ['prova:contrato-do-harness'],
        packs: ['prova:pack-minimo'],
        importers: ['prova:importador-json'],
        views: ['prova:visao-de-slots']
    },
    workflow: {
        states: ['proposto', 'em-execucao', 'verificado'],
        initial: 'proposto'
    },
    hierarchy: {
        levels: ['marco', 'fase', 'tarefa']
    },
    primaryStatus: {
        label: 'Estado principal',
        values: ['bloqueado', 'andando', 'verificado']
    }
};

/** v2 — same provider, new version: one more check, one more workflow state. */
export const TEST_PROVIDER_V2: HarnessManifest = {
    ...TEST_PROVIDER_V1,
    label: 'Harness de prova (v2)',
    version: '2.0.0',
    extensions: {
        ...TEST_PROVIDER_V1.extensions,
        checks: ['prova:contrato-do-harness', 'prova:migracao-preserva-estado']
    },
    workflow: {
        states: ['proposto', 'em-execucao', 'verificado', 'arquivado'],
        initial: 'proposto'
    }
};

/** A rival provider that claims an already-owned slot. Must be rejected. */
export const CONFLICT_PROVIDER: HarnessManifest = {
    id: CONFLICT_PROVIDER_ID,
    label: 'Harness rival (só workflow)',
    version: '1.0.0',
    manifestVersion: 1,
    claims: ['workflow'],
    extensions: { checks: [], packs: [], importers: [], views: [] },
    workflow: { states: ['aberto', 'fechado'], initial: 'aberto' }
};
