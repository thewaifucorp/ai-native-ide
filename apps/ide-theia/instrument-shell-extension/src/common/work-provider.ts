// §9 — the IDE's DEFAULT harness provider: Features, Tasks and computed Status.
//
// It is a provider, not a second system. §1 made the harness provider the sole
// owner of `workflow`, `work-hierarchy` and `primary-status`, so §9 has to claim
// those slots through the same registry every other provider uses — otherwise
// the exclusivity clause would be a claim about a rule the IDE itself breaks.
//
// A project that runs GSD, Scrum or a house method suspends this one and
// activates its own. Nothing here is privileged: the manifest lands in
// `.harness/providers/instrument-work.json` like any other, and the items are
// files in the directory it declares.
//
// ── WHY THE ITEMS ARE JSON, NOT MARKDOWN ─────────────────────────────────────
// The test provider's items are markdown because their only field is a title.
// A §9 item carries criteria, evidence and the hash the evidence was taken over;
// a hand-rolled front matter for that would be a parser nobody asked for. JSON is
// still a file in the project, still reviewable in a diff, and an agent writes it
// with the same tool it writes anything else.
//
// ── THE ONE THING THIS MANIFEST CANNOT DECLARE ──────────────────────────────
// A writable status. `primaryStatus.values` are the seven states `ide-work`
// COMPUTES; the artifact has no status field at all. The values are here so the
// IDE can render them, not so anything can set one.

import { HarnessManifest } from './harness-protocol';

export const WORK_PROVIDER_ID = 'instrument-work';

/** Where §9 items live. Mirrors `ITEMS_DIR_REL` in the sidecar's `work.rs`. */
export const WORK_ITEMS_DIR = '.harness/items';

export const WORK_PROVIDER: HarnessManifest = {
    id: WORK_PROVIDER_ID,
    label: 'Trabalho do Instrument (§9)',
    version: '1.0.0',
    manifestVersion: 1,
    claims: ['workflow', 'work-hierarchy', 'primary-status'],
    extensions: {
        checks: [],
        packs: [],
        importers: [],
        views: ['instrument:trabalho']
    },
    artifacts: {
        itemsDir: WORK_ITEMS_DIR,
        itemExtension: '.json'
    },
    coverage: [
        'Feature → Task → Subtask, com task direta e task servindo mais de uma feature',
        'critérios e evidências versionados no próprio artefato',
        'status calculado a partir de critério, implementação e frescor da prova'
    ],
    limitations: [
        'não roda verificação: a prova é produzida por quem verifica (§4/§15) e registrada aqui',
        'critério proposto por agente aparece e NÃO conta até alguém adotá-lo no arquivo',
        'não importa itens de Jira, Linear ou GitHub — importador é extensão, e não existe ainda'
    ],
    workflow: {
        // O fluxo declarado é o do TRABALHO, não do status: o status é derivado e
        // não pertence a esta lista.
        states: ['declarado', 'implementado', 'verificado'],
        initial: 'declarado'
    },
    hierarchy: {
        levels: ['feature', 'task', 'subtask']
    },
    primaryStatus: {
        label: 'Status (calculado)',
        values: [
            'not_started',
            'in_progress',
            'implemented_not_verified',
            'partially_verified',
            'verified',
            'blocked',
            'evidence_stale'
        ]
    }
};
