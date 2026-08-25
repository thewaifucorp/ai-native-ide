// GRAFO work-surface — the REAL aag knowledge graph of the project, opened as a
// main-area tab (next to Overview / editors). It iframes `/aag/graph.html`, the
// self-contained interactive graph the aag tool emits (inline CSS/JS, no CDN),
// served same-origin by AagStaticContribution. The graph.html already styles
// itself for embedding when it detects it is inside an iframe.

import * as React from 'react';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';

@injectable()
export class GraphWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.graph';

    protected configure(): void {
        this.id = GraphWidget.ID;
        this.addClass('iws-graph-host');
        this.title.label = 'Grafo';
        this.title.caption = 'Grafo — code intelligence (aag)';
        this.title.closable = true;
    }

    protected render(): React.ReactNode {
        return (
            <div className="iws-graph">
                <iframe
                    className="iws-graph-frame"
                    src="/aag/graph.html"
                    title="aag knowledge graph"
                />
            </div>
        );
    }
}
