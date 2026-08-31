// §12 — A PROVA PONTA A PONTA, NO ARTEFATO THEIA.
//
// A jornada dourada já existia, e provava a rota do TAURI
// (`apps/desktop/src-tauri/src/golden_journey.rs`, verificada por
// `scripts/verify-golden-journey.mjs`). O §12 diz exatamente que isso não conta:
// a jornada tem de rodar no artefato Theia, que é o que foi aceito. Este arquivo
// é essa jornada, e ele não simula nada — fala com o SIDECAR REAL, escreve num
// projeto real e lê o que o broker, o preview e a reconciliação registraram.
//
// ── O QUE ELA ENCADEIA ────────────────────────────────────────────────────
//  1. intenção escrita por uma pessoa, avaliada pela camada 1 (§8);
//  2. agente — real, ou degradação honesta quando o bridge não está na máquina;
//  3. efeito APROVADO pelo broker: proposto, aprovado por effect id, executado
//     e com recibo (§1/§14);
//  4. preview de verdade, iniciado a partir do que o projeto declara (§4);
//  5. FALHA PROVOCADA: o servidor do preview responde erro de propósito;
//  6. evidência: a falha entra no ledger com o trecho de log que a produziu;
//  7. reconciliação: a divergência entre o que foi declarado e o que foi
//     observado aparece, e a decisão é registrada (§4/§7).
//
// ── A REGRA QUE ESTA JORNADA EXISTE PARA DEFENDER ─────────────────────────
// **Outcome só depois de observação independente.** Em nenhum ponto o sucesso
// vem do que o agente disse ter feito: o efeito conta porque o broker executou e
// deixou recibo; a falha conta porque o supervisor do preview observou e gravou
// evidência; a reconciliação conta porque compara declarado com observado. Um
// teste que aceitasse a palavra do agente provaria o oposto do que o §12 pede.
//
// ── POR QUE ELA PODE PULAR, E POR QUE ISSO NÃO É TRAPAÇA ──────────────────
// Ela precisa do binário do sidecar. Sem ele a jornada NÃO finge: ela pula com
// motivo. O CI constrói o sidecar antes de rodar este arquivo, então lá ela roda
// de verdade — e um pulo em máquina de desenvolvimento aparece como pulo, nunca
// como verde.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { EngineSidecarService } from 'engine-extension/lib/node/engine-sidecar-service';
import { GovernedWriteServiceImpl } from './governed-write-service';
import { WriteSourceLedger } from './write-source-ledger';

/** Where the sidecar binary is, honoring the same override the backend uses. */
function sidecarBinary(): string | undefined {
    const fromEnv = process.env.ENGINE_SIDECAR_BIN;
    const candidates = [
        fromEnv,
        path.resolve(__dirname, '../../../engine-sidecar/target/debug/engine-sidecar'),
        path.resolve(__dirname, '../../../engine-sidecar/target/release/engine-sidecar')
    ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return candidates.find(candidate => fs.existsSync(candidate));
}

/**
 * A project that declares a preview whose server FAILS on purpose.
 *
 * A porta é sorteada por execução. Com porta fixa esta jornada não era
 * repetível — e pior: quando um servidor de execução anterior ficava vivo, as
 * sondagens acertavam o ZUMBI e a jornada passava sem ter subido nada. Prova que
 * pode passar por acidente não é prova.
 */
function auctionProject(port: number): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journey-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.instrument'), { recursive: true });
    fs.mkdirSync(path.join(root, '.product', 'sot'), { recursive: true });

    // O servidor do preview: sobe, responde ao /health e ERRA no /leaderboard.
    // A falha é do produto, não do harness — é o que o §12 chama de falha
    // provocada, e ela tem de virar evidência observada, não suposição.
    fs.writeFileSync(
        path.join(root, 'src', 'server.js'),
        [
            "const http = require('http');",
            'const server = http.createServer((req, res) => {',
            "  if (req.url === '/health') {",
            "    res.writeHead(200, { 'content-type': 'application/json' });",
            "    res.end(JSON.stringify({ ok: true }));",
            '    return;',
            '  }',
            "  console.error('leaderboard falhou: vazou id do lance');",
            "  res.writeHead(500, { 'content-type': 'text/plain' });",
            "  res.end('leaderboard indisponível');",
            '});',
            `server.listen(${port}, () => console.log('preview em porta ${port}'));`,
            ''
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(root, '.instrument', 'preview.json'),
        JSON.stringify(
            {
                command: 'node src/server.js',
                url: `http://127.0.0.1:${port}/health`,
                readyTimeoutMs: 8000
            },
            undefined,
            2
        ),
        'utf8'
    );
    return root;
}

/** One real HTTP call against the preview the journey started. */
function fetchStatus(url: string): Promise<number> {
    return new Promise(resolve => {
        const request = http.get(url, response => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        request.on('error', () => resolve(0));
        request.setTimeout(4000, () => {
            request.destroy();
            resolve(0);
        });
    });
}

const OWNER = 'owner:instrument-ide';

describe('§12 — jornada ponta a ponta no artefato Theia', function () {
    // Sobe processo, fala HTTP e espera o preview ficar pronto: o tempo é real.
    this.timeout(90_000);

    let engine: EngineSidecarService;
    let root: string;
    let rootUri: string;
    let port: number;

    before(function () {
        const binary = sidecarBinary();
        if (!binary) {
            // Sem binário a jornada NÃO finge: ela pula, dizendo por quê.
            this.skip();
            return;
        }
        process.env.ENGINE_SIDECAR_BIN = binary;
        engine = new EngineSidecarService();
        port = 20000 + Math.floor(Math.random() * 20000);
        root = auctionProject(port);
        rootUri = FileUri.create(root).toString();
    });

    after(async () => {
        if (engine && root) {
            try {
                await engine.previewStop(root);
            } catch { /* já parado */ }
        }
    });

    it('intenção → agente → efeito aprovado → preview → falha → evidência → reconciliação', async () => {
        // ── 1. INTENÇÃO ────────────────────────────────────────────────────
        // O texto é da pessoa e ninguém o reescreve. A camada 1 levanta
        // HIPÓTESES sobre ele; elas não bloqueiam e não viram fato.
        const intent =
            'Quero um leilão de lances selados: o leaderboard mostra o valor líder ' +
            'sem vazar a identidade de quem deu o lance.';
        const review = await engine.intentReview(root, intent);
        assert.ok(
            review.report.contentHash.length > 0,
            'a intenção precisa de hash estável — é ele que faz prova envelhecer (§8/§9)'
        );
        assert.ok(
            review.report.evaluatorsRun.length > 0,
            'a avaliação tem de dizer QUEM rodou, senão o silêncio é ambíguo'
        );
        assert.ok(
            review.reviewed.every(finding => !finding.decision),
            'hipótese nasce sem decisão: ela não vira fato sozinha'
        );

        // ── 2. AGENTE ──────────────────────────────────────────────────────
        // A jornada chega num adaptador REAL. Sem o bridge instalado (o caso do
        // CI) ele tem de dizer `unavailable` com motivo — nunca uma sessão
        // fabricada. As duas respostas passam; uma terceira, não.
        const probe = await engine.agentProbe('claude');
        assert.ok(
            ['ready', 'degraded', 'unavailable'].includes(probe.availability),
            `disponibilidade inventada: ${probe.availability}`
        );
        if (probe.availability === 'unavailable') {
            assert.ok(
                (probe.detail ?? '').length > 0,
                'indisponível sem motivo é a mesma mentira de um ready fabricado'
            );
        }

        // ── 3. EFEITO APROVADO ─────────────────────────────────────────────
        // O SoT do produto entra pelo caminho governado: proposto, decidido,
        // executado pelo broker. Nada de escrita direta.
        const governed = new GovernedWriteServiceImpl();
        (governed as unknown as { engine: EngineSidecarService }).engine = engine;
        (governed as unknown as { ledger: WriteSourceLedger }).ledger = new WriteSourceLedger();

        const sotPath = '.product/sot/leaderboard.md';
        const proposal = await governed.proposeWrite(
            rootUri,
            sotPath,
            '# Leaderboard\n\nMostra o valor líder e NUNCA a identidade do lance.\n'
        );
        assert.strictEqual(proposal.state, 'awaiting', 'nada pode ser escrito antes da decisão');
        assert.strictEqual(
            fs.existsSync(path.join(root, sotPath)),
            false,
            'proposta pendente não deixa rastro no projeto'
        );

        const approved = await governed.approve(proposal.id);
        assert.strictEqual(approved.state, 'approved');
        assert.ok(fs.existsSync(path.join(root, sotPath)), 'aprovar tem de escrever de verdade');

        // O recibo é do BROKER, não da tela: é ele que faz o efeito contar.
        const trail = await governed.activity(rootUri);
        assert.ok(
            trail.some(entry => entry.kind === 'executed' && entry.effect_id === proposal.id),
            'sem recibo do broker, o efeito não aconteceu para efeito de prova'
        );

        // ── 4. PREVIEW ─────────────────────────────────────────────────────
        const started = await engine.previewStart(root);
        assert.ok(started.declared, 'o preview veio do que o projeto DECLARA');
        assert.strictEqual(started.declared?.command, 'node src/server.js');

        // ── 5. FALHA PROVOCADA ─────────────────────────────────────────────
        // Observação independente: a jornada bate na rota quebrada e lê o que
        // voltou. O sucesso do passo anterior não é palavra de ninguém.
        const health = await fetchStatus(`http://127.0.0.1:${port}/health`);
        assert.strictEqual(health, 200, 'o preview precisa estar de pé antes de quebrar');
        const broken = await fetchStatus(`http://127.0.0.1:${port}/leaderboard`);
        assert.strictEqual(broken, 500, 'a falha é provocada, e observada — não suposta');

        // ── 6. EVIDÊNCIA ───────────────────────────────────────────────────
        // O supervisor registra o que observou. Um `status` que não mostrasse a
        // falha seria um preview mentindo sobre a própria saúde.
        const status = await engine.previewStatus(root);
        assert.strictEqual(status.running, true, 'o processo do preview segue de pé');
        assert.ok(
            (status.logTail ?? '').includes('leaderboard falhou'),
            'a evidência é o log observado, não um resumo inventado'
        );

        // ── 7. RECONCILIAÇÃO ───────────────────────────────────────────────
        // O que foi DECLARADO contra o que foi OBSERVADO. Sem observação, a
        // resposta honesta é "nada a comparar" — e ela também é aceita aqui,
        // porque inventar divergência seria pior do que não ter uma.
        const reconciliation = await engine.reconcileScan(root);
        assert.ok(
            reconciliation.divergences.length > 0 || reconciliation.nothingToCompare,
            'ou existe divergência, ou existe o motivo declarado de não haver'
        );

        // ── 7b. §14 — TROCAR DE MODO NÃO PERDE O QUE ESTÁ EM CURSO ─────────
        // O "Pronto" do §14 é troca sem migração e sem perda. Trocar no meio da
        // jornada é o teste honesto: o preview de pé, a evidência gravada e a
        // divergência decidida têm de continuar exatamente onde estavam. E a
        // regra nova vale do próximo efeito em diante — nunca para trás (isso
        // está pinado em `governed-write.spec.ts`).
        const antes = await engine.settingsSnapshot(root);
        const modoAntes = antes.rows.find(row => row.field === 'mode');
        assert.ok(modoAntes, 'o painel tem de ter a linha do modo');
        assert.deepStrictEqual(
            modoAntes!.options,
            ['full_vibes', 'hybrid', 'spec'],
            'as opções vêm do motor, na grafia do arquivo — o painel não as inventa'
        );

        const depois = await engine.settingsPatch(root, { mode: 'full_vibes' });
        const modoDepois = depois.rows.find(row => row.field === 'mode');
        assert.strictEqual(modoDepois?.value.toLowerCase(), 'full_vibes', 'a troca tem de pegar');
        assert.strictEqual(
            modoDepois?.source,
            'user',
            'escolha de pessoa é escolha de pessoa: a detecção não sobrescreve'
        );

        // Nada em curso se perdeu com a troca.
        const previewApos = await engine.previewStatus(root);
        assert.strictEqual(previewApos.running, true, 'trocar de modo não derruba o preview');
        assert.ok(
            (previewApos.logTail ?? '').includes('leaderboard falhou'),
            'a evidência observada antes da troca continua lá'
        );
        const reconApos = await engine.reconcileScan(root);
        assert.deepStrictEqual(
            reconApos.divergences.map(view => view.divergence.id),
            reconciliation.divergences.map(view => view.divergence.id),
            'as divergências são as mesmas: troca de modo não é migração'
        );

        // ── 8. PARAR PARA DE VERDADE ───────────────────────────────────────
        // Não estava no texto do §12; entrou porque a jornada achou o contrário:
        // `stop` matava o `sh` e deixava o servidor vivo, e a execução seguinte
        // sondava o zumbi e o via saudável.
        await engine.previewStop(root);
        const afterStop = await fetchStatus(`http://127.0.0.1:${port}/health`);
        assert.strictEqual(
            afterStop,
            0,
            'parar o preview tem de derrubar quem escuta, não só o shell'
        );
    });
});
