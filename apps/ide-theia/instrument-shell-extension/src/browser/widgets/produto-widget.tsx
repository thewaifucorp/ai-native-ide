// PRODUTO — a visão semântica do projeto (§3).
//
// Era o esboço: seções "Visão / Construção / Recursos / Evidência / Publicação"
// com números fixos e uma tag `mock`. Agora renderiza o modelo que o backend leu
// dos artefatos em `.product/`: recursos com autoridade e consumidores, fontes da
// verdade, e o resultado de cada afirmação contra os arquivos reais.
//
// Regras que a tela respeita:
//  • divergência é calculada, então esta view não tem estado próprio;
//  • `unknown` (arquivo ausente, ilegível, fora da raiz) aparece como `unknown`,
//    nunca como conformidade;
//  • exceção registrada aparece como exceção, com o motivo — não como "ok";
//  • resolver abre uma proposta no broker; nada é consertado aqui.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { CMD_OPEN_RESOURCE } from '../instrument-data-contribution';
import {
    CMD_PRODUCT_ADOPT,
    CMD_PRODUCT_ANALYZE,
    CMD_PRODUCT_REFRESH,
    CMD_PRODUCT_RESOLVE
} from '../instrument-capability-contribution';
import { CMD_SHOW_SURFACE } from '../instrument-shell-contribution';
import { ClaimResult, ProductModel } from '../../common/product-protocol';

/** Pill class por status — só `ok` recebe a cor saudável. */
const STATUS_PILL: Record<string, string> = {
    ok: 'ready',
    divergent: 'unavailable',
    unknown: 'unknown',
    excepted: 'degraded'
};

@injectable()
export class ProdutoWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.produto';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = ProdutoWidget.ID;
        this.addClass('iws-produto-host');
        this.title.label = 'Produto';
        this.title.caption = 'Produto — projeto semântico e fontes da verdade';
        this.title.closable = false;
    }

    protected render(): React.ReactNode {
        const model = this.store.product;
        return (
            <div className="nav">
                <div className="proj-head">
                    <div className="name">{this.store.workspaceName || 'workspace'}</div>
                    <div className="meta">
                        {model
                            ? `${model.resources.length} recursos · ${model.sots.length} fontes da verdade`
                            : 'lendo o projeto semântico…'}
                    </div>
                </div>
                {this.renderClaims(model)}
                {this.renderCandidates()}
                {this.renderResources(model)}
                {this.renderSots(model)}
                {this.renderInvalid(model)}
            </div>
        );
    }

    /** O coração da view: intenção contra implementação. */
    protected renderClaims(model: ProductModel | undefined): React.ReactNode {
        const claims = model?.claims ?? [];
        const divergent = claims.filter(c => c.status === 'divergent');
        return (
            <div className="nav-sec">
                <span className="tag">
                    Projeto × software atual
                    <button
                        className="cap-btn tiny"
                        disabled={this.store.productBusy}
                        onClick={() => this.commands.executeCommand(CMD_PRODUCT_REFRESH)}
                    >
                        {this.store.productBusy ? '…' : 'reverificar'}
                    </button>
                </span>

                {!model && <div className="cap-card"><small>lendo…</small></div>}

                {model && !model.declared && (
                    <div className="cap-card">
                        <small>
                            nenhum artefato em `.product/` — sem fonte da verdade declarada não há
                            divergência a calcular
                        </small>
                        <div className="cap-actions">
                            <button
                                className="cap-btn"
                                onClick={() => this.commands.executeCommand(CMD_PRODUCT_ANALYZE)}
                            >
                                Analisar projeto
                            </button>
                        </div>
                    </div>
                )}

                {model && model.declared && claims.length === 0 && (
                    <div className="cap-card">
                        <small>
                            nenhuma afirmação declarada — uma fonte da verdade sem `claims` não
                            afirma nada verificável
                        </small>
                    </div>
                )}

                {model && divergent.length === 0 && claims.length > 0 && (
                    <div className="cap-card">
                        <small>o software atual corresponde ao que o projeto descreve</small>
                    </div>
                )}

                {claims.map(claim => this.renderClaim(claim))}
            </div>
        );
    }

    protected renderClaim(claim: ClaimResult): React.ReactNode {
        return (
            <div className="cap-card" key={`${claim.sotId}:${claim.claimId}`}>
                <div className="cap-head">
                    <b>{claim.statement}</b>
                    <span className={`cap-pill ${STATUS_PILL[claim.status] ?? 'unknown'}`}>
                        {claim.status}
                    </span>
                </div>
                <p className="cap-detail">{claim.evidence}</p>
                <small className="cap-ver">
                    {claim.path}{claim.line ? `:${claim.line}` : ''} · fonte: {claim.sotId}
                    {claim.affectedResources.length > 0
                        ? ` · afeta ${claim.affectedResources.join(', ')}`
                        : ''}
                </small>
                {this.renderChain(claim)}
                <div className="cap-actions">
                    {claim.status === 'divergent' && (
                        <>
                            <button
                                className="cap-btn primary"
                                disabled={this.store.productBusy}
                                title="Propõe mudar a implementação — vai ao broker"
                                onClick={() => this.commands.executeCommand(
                                    CMD_PRODUCT_RESOLVE, claim.sotId, claim.claimId, 'remove-offending-line'
                                )}
                            >
                                Mudar implementação
                            </button>
                            <button
                                className="cap-btn"
                                disabled={this.store.productBusy}
                                title="Propõe registrar exceção escopada no próprio SoT"
                                onClick={() => this.commands.executeCommand(
                                    CMD_PRODUCT_RESOLVE, claim.sotId, claim.claimId, 'accept-exception'
                                )}
                            >
                                Registrar exceção
                            </button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    /**
     * §14 — a cadeia navegável: assunto → fonte da verdade → implementação →
     * evidência.
     *
     * Os quatro elos já existiam como TEXTO no cartão, e só o terceiro abria. A
     * fonte ficava como um id (`fonte: leaderboard-intent`) que a pessoa tinha de
     * ir procurar; e a implementação abria o arquivo sem levar à linha que o
     * próprio painel acabou de citar. Um elo que não navega não é um elo.
     *
     * O grafo entra como ENRIQUECIMENTO, nunca como requisito: quando o aag não
     * está pronto, a cadeia continua inteira e o cartão diz o estado e o motivo
     * que a detecção deu, em vez de oferecer um botão que não faz nada.
     */
    protected renderChain(claim: ClaimResult): React.ReactNode {
        const model = this.store.product;
        const sot = model?.sots.find(source => source.id === claim.sotId);
        // `grafo` é a CAPABILITY; `aag-local` é o provider dela. Procurar pelo id
        // do provider aqui devolvia undefined sempre, e a cadeia dizia "grafo não
        // detectado" mesmo com o grafo pronto — degradação falsa é tão ruim como
        // esconder a degradação.
        const graph = this.store.capabilities.find(capability => capability.id === 'grafo');
        const graphReady = graph?.status === 'ready';

        return (
            <div className="chain">
                <span className="chain-step">assunto</span>
                <span className="chain-arrow">›</span>
                {sot ? (
                    <button
                        className="chain-link"
                        title={`abre ${sot.path} — a fonte que afirma isto`}
                        onClick={() => this.openPath(sot.path)}
                    >
                        {sot.label || sot.id}
                    </button>
                ) : (
                    <span className="chain-step" title={`o SoT ${claim.sotId} não está no modelo lido`}>
                        {claim.sotId} (fonte não lida)
                    </span>
                )}
                <span className="chain-arrow">›</span>
                <button
                    className="chain-link"
                    title={
                        claim.line
                            ? `abre ${claim.path} na linha ${claim.line}`
                            : `abre ${claim.path}`
                    }
                    onClick={() => this.openPath(claim.path, claim.line)}
                >
                    {claim.path}
                    {claim.line ? `:${claim.line}` : ''}
                </button>
                <span className="chain-arrow">›</span>
                <span className="chain-step" title={claim.evidence}>
                    evidência
                </span>
                {graphReady ? (
                    <button
                        className="chain-link"
                        title="abre o grafo local (aag) — quem mais toca neste código"
                        onClick={() => this.commands.executeCommand(CMD_SHOW_SURFACE, 'grafo')}
                    >
                        ver no grafo
                    </button>
                ) : (
                    <span className="chain-degraded">
                        grafo {graph?.status ?? 'não detectado'}
                        {graph?.detail ? ` — ${graph.detail}` : ''} · a cadeia acima não depende dele
                    </span>
                )}
            </div>
        );
    }

    /**
     * PROJ-06 — o que a análise encontrou num projeto que ainda não declarou
     * nada. É a única parte desta view que fala de algo que NÃO está no disco,
     * então cada item diz onde seria gravado antes de a pessoa clicar.
     *
     * Adotar um SoT candidato não produz verificação nenhuma: o candidato vem sem
     * `claims`, e o cartão diz isso — senão a tela venderia "fonte da verdade" e
     * entregaria um arquivo que não afirma nada.
     */
    protected renderCandidates(): React.ReactNode {
        const found = this.store.productCandidates;
        if (!found || (found.resources.length === 0 && found.sots.length === 0)) {
            return null;
        }
        const busy = this.store.productBusy;
        return (
            <div className="nav-sec">
                <span className="tag">Candidatos encontrados</span>
                <div className="cap-card">
                    <small>
                        nada foi gravado ainda — adotar escreve UM artefato em `.product/`, que
                        entra no Git como qualquer outro arquivo
                    </small>
                </div>
                {found.sots.map(sot => (
                    <div className="cap-card" key={`sot:${sot.id}`}>
                        <div className="cap-head">
                            <b>{sot.label || sot.id}</b>
                            <span className="cap-pill not-installed">{sot.kind}</span>
                        </div>
                        <small
                            role="button"
                            style={{ cursor: 'pointer' }}
                            onClick={() => this.openPath(sot.path)}
                        >
                            documento: {sot.path}
                        </small>
                        <small>gravaria em: .product/sot/{sot.id}.json</small>
                        <small>
                            sem afirmações — depois de adotar, escreva `claims` no artefato para
                            haver divergência a calcular
                        </small>
                        <div className="cap-actions">
                            <button
                                className="cap-btn primary"
                                disabled={busy}
                                onClick={() => this.commands.executeCommand(
                                    CMD_PRODUCT_ADOPT, 'sot', sot.id
                                )}
                            >
                                Adotar fonte
                            </button>
                        </div>
                    </div>
                ))}
                {found.resources.map(resource => (
                    <div className="cap-card" key={`res:${resource.id}`}>
                        <div className="cap-head">
                            <b>{resource.label || resource.id}</b>
                            <span className="cap-pill unknown">candidato</span>
                        </div>
                        <small>{resource.paths.length} arquivo(s)</small>
                        <small>gravaria em: .product/resources/{resource.id}.json</small>
                        <div className="cap-actions">
                            <button
                                className="cap-btn"
                                disabled={busy}
                                onClick={() => this.commands.executeCommand(
                                    CMD_PRODUCT_ADOPT, 'resource', resource.id
                                )}
                            >
                                Adotar recurso
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    protected renderResources(model: ProductModel | undefined): React.ReactNode {
        const resources = model?.resources ?? [];
        if (resources.length === 0) {
            return null;
        }
        return (
            <div className="nav-sec">
                <span className="tag">Recursos declarados</span>
                {resources.map(r => (
                    <div className="cap-card" key={r.id}>
                        <div className="cap-head">
                            <b>{r.label || r.id}</b>
                            {!r.authority && <span className="cap-pill unknown">sem autoridade</span>}
                        </div>
                        {r.authority && <small>autoridade: {r.authority}</small>}
                        <small>
                            consumidores: {r.consumers.length > 0 ? r.consumers.join(', ') : 'nenhum declarado'}
                        </small>
                        <div className="cap-providers">
                            {r.paths.map(p => (
                                <div
                                    className="cap-provider"
                                    key={p}
                                    role="button"
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => this.openPath(p)}
                                >
                                    <span className="st ok" />
                                    <span className="cap-provider-name">{p}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    protected renderSots(model: ProductModel | undefined): React.ReactNode {
        const sots = model?.sots ?? [];
        if (sots.length === 0) {
            return null;
        }
        return (
            <div className="nav-sec">
                <span className="tag">Fontes da verdade</span>
                {sots.map(sot => (
                    <div className="cap-card" key={sot.id}>
                        <div className="cap-head">
                            <b>{sot.label || sot.id}</b>
                            <span className="cap-pill not-installed">{sot.kind}</span>
                        </div>
                        <small
                            role="button"
                            style={{ cursor: 'pointer' }}
                            onClick={() => this.openPath(sot.path)}
                        >
                            documento: {sot.path}
                        </small>
                        <small>artefato: {sot.manifestPath}</small>
                        <small>
                            autoridade sobre: {sot.authorityOver.length > 0
                                ? sot.authorityOver.join(', ')
                                : 'nada declarado'}
                        </small>
                        <small>{(sot.claims ?? []).length} afirmação(ões)</small>
                    </div>
                ))}
            </div>
        );
    }

    protected renderInvalid(model: ProductModel | undefined): React.ReactNode {
        const invalid = model?.invalid ?? [];
        if (invalid.length === 0) {
            return null;
        }
        return (
            <div className="nav-sec">
                <span className="tag">Artefatos ilegíveis</span>
                <div className="cap-card">
                    <ul className="cap-degr">
                        {invalid.map(i => <li key={i.path}>{i.path} — {i.reason}</li>)}
                    </ul>
                </div>
            </div>
        );
    }

    /** Abre um caminho relativo do projeto no editor real. */
    protected openPath(relPath: string, line?: number): void {
        const root = this.store.workspaceRootUri;
        if (!root) {
            return;
        }
        this.commands.executeCommand(CMD_OPEN_RESOURCE, `${root}/${relPath}`, line);
    }
}
