// GENERIC CAPABILITY SURFACE — a MAIN-area tab that renders whichever hosted
// capability has an embeddable surface. It replaces the old GraphWidget, which
// hard-coded `/aag/graph.html`.
//
// Everything on screen comes from the capability state the backend registry
// detected: the title, the honest status line, and whether an action is offered.
// The widget knows nothing about aag. Point it at another capability with a
// surface and it renders that one instead.
//
// The four honest states:
//
//   detecting      — detection has not answered yet. Never shown as healthy.
//   ready          — iframe the artifact, using the URL the registry returned
//                    (it carries the detection stamp, so a freshly generated
//                    artifact renders WITHOUT a manual reload).
//   not-installed  — the real generate action, offered because the backend said
//                    `installable`. Running it re-detects and flips to ready.
//   blocked        — tool-missing / unavailable / unknown: the reason, verbatim,
//                    and no action that would pretend to fix it.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { CapabilityState } from '../../common/capability-protocol';
import { CMD_CAP_DETECT, CMD_CAP_INSTALL } from '../instrument-capability-contribution';

/** Capability shown when nothing has selected one yet (the Grafo nav mode). */
export const DEFAULT_SURFACE_CAPABILITY = 'grafo';

@injectable()
export class CapabilitySurfaceWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.capability-surface';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = CapabilitySurfaceWidget.ID;
        this.addClass('iws-graph-host');
        this.title.label = 'Grafo';
        this.title.caption = 'Superfície de capability';
        this.title.closable = true;
    }

    protected get capabilityId(): string {
        return this.store.surfaceCapabilityId || DEFAULT_SURFACE_CAPABILITY;
    }

    protected render(): React.ReactNode {
        const id = this.capabilityId;
        const capability = this.store.capability(id);
        // Keep the tab title honest about which capability is mounted.
        const label = capability?.label ?? id;
        if (this.title.label !== label) {
            this.title.label = label;
        }
        if (!capability) {
            return this.frame(
                id,
                undefined,
                <div className="cap-empty">
                    <b>Detectando…</b>
                    <p>
                        {this.store.capabilitiesDetected
                            ? `Nenhuma capability '${id}' registrada neste backend.`
                            : 'O registry ainda não respondeu para este projeto.'}
                    </p>
                </div>
            );
        }
        if (capability.status === 'ready' && capability.surface.kind === 'iframe' && capability.surface.url) {
            return this.frame(
                id,
                capability,
                <iframe
                    className="iws-graph-frame"
                    // The URL carries the detection stamp: a regenerated artifact
                    // gets a different src, so React remounts the iframe.
                    key={capability.surface.url}
                    src={capability.surface.url}
                    title={capability.label}
                />
            );
        }
        return this.frame(id, capability, this.renderBlocked(capability));
    }

    protected renderBlocked(capability: CapabilityState): React.ReactNode {
        const busy = this.store.isCapabilityBusy(capability.id);
        return (
            <div className="cap-empty">
                <b>{capability.label} · {capability.status}</b>
                <p>{capability.detail}</p>
                {capability.degradations.length > 0 && (
                    <ul className="cap-degr">
                        {capability.degradations.map(d => <li key={d}>{d}</li>)}
                    </ul>
                )}
                <div className="cap-actions">
                    {capability.installable && capability.installLabel && (
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_CAP_INSTALL, capability.id)}
                        >
                            {busy ? 'Gerando…' : capability.installLabel}
                        </button>
                    )}
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_CAP_DETECT, capability.id)}
                    >
                        Detectar novamente
                    </button>
                </div>
            </div>
        );
    }

    /** Common chrome: a one-line honest status header above the surface. */
    protected frame(
        id: string,
        capability: CapabilityState | undefined,
        body: React.ReactNode
    ): React.ReactNode {
        return (
            <div className="iws-graph">
                <div className="cap-surface-head">
                    <span className={`cap-pill ${capability?.status ?? 'unknown'}`}>
                        {capability?.status ?? 'detectando'}
                    </span>
                    <span className="cap-surface-id">{capability?.label ?? id}</span>
                    {capability?.detectedVersion && (
                        <span className="cap-surface-ver">{capability.detectedVersion}</span>
                    )}
                </div>
                {body}
            </div>
        );
    }
}
