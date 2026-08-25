// 001 "Produto" NAVIGATOR MODE — the bespoke SEMANTIC view of the project, as
// opposed to the raw file tree (that is the "Arquivos" mode = real @theia
// navigator). This is the semantic re-homing sketched in 001/003: a project
// header plus the meaning-first sections (Visão / Construção / Recursos /
// Evidência / Publicação) and the live resources list.
//
// It is a real Theia widget living in the native LEFT area (added by the shell
// contribution, revealed by the "Produto" mode button). Content is bespoke and
// static for now — M3 wires it to real project/agent state.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { Icon } from './icons';
import { CMD_OPEN_RESOURCE } from '../instrument-data-contribution';

@injectable()
export class ProdutoWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.produto';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = ProdutoWidget.ID;
        this.addClass('iws-produto-host');
        this.title.label = 'Produto';
        this.title.caption = 'Produto — visão semântica';
        this.title.closable = false;
    }

    protected render(): React.ReactNode {
        // REAL: opened workspace + its top-level resources (WorkspaceService + FileService).
        const name = this.store.workspaceName || 'workspace';
        const resources = this.store.resources;
        return (
            <div className="nav">
                <div className="proj-head">
                    <div className="name">{name}</div>
                    <div className="meta">{resources.length} recursos no topo · workspace real</div>
                </div>

                {/* Semantic sections are still bespoke atmosphere (agent/session state is M4). */}
                <div className="nav-sec">
                    <span className="tag">Produto (semântico · mock)</span>
                    <button className="nav-item on"><Icon name="overview" />Visão geral</button>
                    <button className="nav-item"><Icon name="build" />Construção<span className="n">2</span></button>
                    <button className="nav-item"><Icon name="resources" />Recursos<span className="n">{resources.length}</span></button>
                    <button className="nav-item"><Icon name="evidence" />Evidência<span className="n warn">1</span></button>
                    <button className="nav-item"><Icon name="ship" />Publicação</button>
                </div>

                <div className="nav-sec">
                    <span className="tag">Recursos do workspace (real)</span>
                    {resources.length === 0 && <div className="res"><small>nenhum recurso no topo</small></div>}
                    {resources.map(r => (
                        <div
                            key={r.uri}
                            className="res"
                            role="button"
                            title={r.isDir ? `Abrir pasta ${r.name}` : `Abrir ${r.name} no editor`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => this.commands.executeCommand(CMD_OPEN_RESOURCE, r.uri)}
                        >
                            <b>{r.name}</b>
                            <small><span className={`st ${r.isDir ? 'idle' : 'ok'}`} />{r.isDir ? 'pasta' : 'arquivo'}</small>
                        </div>
                    ))}
                </div>

                <div className="nav-sec">
                    <span className="tag">Sessão (mock)</span>
                    <button className="nav-item"><Icon name="session" />Campanha pública</button>
                    <button className="nav-item"><Icon name="history" />Histórico</button>
                </div>
            </div>
        );
    }
}
