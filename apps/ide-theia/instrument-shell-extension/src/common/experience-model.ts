import {
    LifecycleSnapshot,
    PreviewSnapshot,
    ProvidersSnapshot,
    ReleaseSnapshot,
    ShareSnapshot
} from 'engine-extension';

/** A project session is revealed by facts, never by a flag somebody has to maintain. */
export type SessionAvailability = 'locked' | 'ready' | 'active' | 'failed';
export type ProjectSessionId = 'preview' | 'share' | 'ship';

export interface ProjectSessionState {
    id: ProjectSessionId;
    label: string;
    availability: SessionAvailability;
    /** Human reason for this state. Empty reasons would turn a lock into a mystery. */
    reason: string;
    /** The smallest useful action that can move a locked or failed session forward. */
    unlockAction?: string;
}

export interface ExperienceFacts {
    preview?: PreviewSnapshot;
    lifecycle?: LifecycleSnapshot;
    release?: ReleaseSnapshot;
    share?: ShareSnapshot;
    providers?: ProvidersSnapshot;
}

/**
 * Derives the navigation state from material the engines already observed.
 * Nothing is persisted here: changing preview/release state immediately changes
 * the experience, and an old boolean can never leave a dead tab "unlocked".
 */
export function deriveProjectSessions(facts: ExperienceFacts): ProjectSessionState[] {
    const preview = derivePreview(facts.preview);
    const share = deriveShare(facts.share, preview);
    const ship = deriveShip(facts.lifecycle, facts.release, facts.providers);
    return [preview, share, ship];
}

function derivePreview(snapshot?: PreviewSnapshot): ProjectSessionState {
    if (!snapshot?.declared) {
        return {
            id: 'preview',
            label: 'Preview',
            availability: 'locked',
            reason: snapshot?.notDeclaredReason || 'Nenhuma forma de executar este projeto foi encontrada.',
            unlockAction: 'Detectar ou configurar como executar'
        };
    }
    if (snapshot.state?.health === 'broken') {
        return {
            id: 'preview',
            label: 'Preview',
            availability: 'failed',
            reason: snapshot.state.detail || 'O preview foi iniciado, mas falhou.',
            unlockAction: 'Investigar a falha'
        };
    }
    if (snapshot.running) {
        return {
            id: 'preview',
            label: 'Preview',
            availability: 'active',
            reason: snapshot.state?.detail || snapshot.lastProbe || 'Preview em execução.'
        };
    }
    return {
        id: 'preview',
        label: 'Preview',
        availability: 'ready',
        reason: `Pronto para executar: ${snapshot.declared.command}`
    };
}

function deriveShare(
    snapshot: ShareSnapshot | undefined,
    preview: ProjectSessionState
): ProjectSessionState {
    if (snapshot?.active) {
        return {
            id: 'share',
            label: 'Compartilhar',
            availability: 'active',
            reason: `Aberto em ${snapshot.active.url}`
        };
    }
    if (snapshot?.previewUrl || preview.availability === 'active') {
        return {
            id: 'share',
            label: 'Compartilhar',
            availability: 'ready',
            reason: snapshot?.previewUrl
                ? `O preview pode ser compartilhado: ${snapshot.previewUrl}`
                : 'O preview ativo pode ser compartilhado.'
        };
    }
    return {
        id: 'share',
        label: 'Compartilhar',
        availability: 'locked',
        reason: snapshot?.blockedReason || 'Compartilhar é liberado quando o preview está funcionando.',
        unlockAction: preview.availability === 'locked' ? preview.unlockAction : 'Iniciar o preview'
    };
}

function deriveShip(
    lifecycle?: LifecycleSnapshot,
    release?: ReleaseSnapshot,
    providers?: ProvidersSnapshot
): ProjectSessionState {
    if (!lifecycle || lifecycle.blockedReason) {
        return {
            id: 'ship',
            label: 'Entregar',
            availability: 'locked',
            reason: lifecycle?.blockedReason || 'O projeto ainda não tem uma versão que possa ser consolidada.',
            unlockAction: 'Preparar uma primeira versão'
        };
    }
    const published = lifecycle.history.some(record => record.deployments.length > 0)
        || !!release?.versions.some(version => version.pushed || !!version.releaseUrl);
    if (published) {
        return {
            id: 'ship',
            label: 'Entregar',
            availability: 'active',
            reason: 'Este projeto já possui uma versão entregue.'
        };
    }
    const hasDestination = !!release?.remote
        || !!providers?.providers.some(provider => provider.configExists);
    return {
        id: 'ship',
        label: 'Entregar',
        availability: 'ready',
        reason: hasDestination
            ? 'Versões e um destino de entrega estão disponíveis.'
            : 'O projeto pode consolidar uma versão; o destino será escolhido ao entregar.',
        unlockAction: hasDestination ? undefined : 'Escolher um destino'
    };
}
