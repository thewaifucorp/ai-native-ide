import * as React from 'react';
import { injectable } from '@theia/core/shared/inversify';
import { ToolsWidget } from './tools-widget';

/** The durable project controls that used to be mixed into Ferramentas. */
@injectable()
export class ProjectWidget extends ToolsWidget {
    static readonly PROJECT_ID = 'instrument.project';

    protected override configure(): void {
        this.id = ProjectWidget.PROJECT_ID;
        this.addClass('iws-tools-host');
        this.title.label = 'Projeto';
        this.title.caption = 'Projeto, trabalho e agentes';
        this.title.closable = false;
    }

    protected override render(): React.ReactNode {
        const model = this.store.product;
        const open = model?.claims.filter(claim => claim.status === 'divergent').length ?? 0;
        return (
            <div className="nav project-surface">
                {this.renderSurfaceHeader(
                    this.store.workspaceName || 'Projeto',
                    'software, trabalho e agentes'
                )}
                <div className="nav-sec">
                    <span className="tag">Estado do software</span>
                    <div className="cap-card">
                        <div className="cap-head">
                            <b>{model?.declared ? 'Projeto descrito' : 'Projeto ainda não analisado'}</b>
                            <span className={`cap-pill ${open > 0 ? 'unavailable' : model?.declared ? 'ready' : 'not-installed'}`}>
                                {open > 0 ? `${open} diferença(s)` : model?.declared ? 'atual' : 'sem modelo'}
                            </span>
                        </div>
                        <small className="cap-hint">
                            {model
                                ? `${model.resources.length} recurso(s) · ${model.sots.length} descrição(ões) verificável(is)`
                                : 'A análise do projeto aparece aqui quando estiver disponível.'}
                        </small>
                    </div>
                </div>
                {this.renderDurable()}
                {this.renderWork()}
                {this.renderAgentDefs()}
                {this.renderPromotion()}
            </div>
        );
    }
}
