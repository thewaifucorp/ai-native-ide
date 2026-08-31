// PROJETO SEMÂNTICO E SoTs — implementação.
//
// Ver common/product-protocol.ts para o contrato e o porquê. Aqui só o mecanismo:
// ler artefatos de `.product/`, verificar cada afirmação contra os arquivos reais,
// e oferecer resolução como proposta ao broker.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import { GovernedWriteService } from '../common/governed-protocol';
import {
    Claim,
    ClaimResult,
    ProductModel,
    PRODUCT_DIR,
    ProductService,
    ProjectResource,
    ResolutionOption,
    SourceOfTruth
} from '../common/product-protocol';
import { WriteSourceLedger } from './write-source-ledger';

const SOT_DIR = path.join(PRODUCT_DIR, 'sot');
const RESOURCE_DIR = path.join(PRODUCT_DIR, 'resources');

/** Não vale a pena varrer isto ao propor candidatos. */
const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.instrument', '.product', '.harness', '.aag',
    'target', 'lib', 'dist', 'src-gen', 'plugins'
]);

const MAX_READ_BYTES = 512 * 1024;

@injectable()
export class ProductServiceImpl implements ProductService {

    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(WriteSourceLedger) protected readonly ledger!: WriteSourceLedger;

    async model(rootUri: string): Promise<ProductModel> {
        const root = this.rootPath(rootUri);
        const invalid: { path: string; reason: string }[] = [];
        const sots = this.readAll<SourceOfTruth>(root, SOT_DIR, invalid, s => this.validateSot(s));
        const resources = this.readAll<ProjectResource>(
            root, RESOURCE_DIR, invalid, r => this.validateResource(r)
        );

        const claims: ClaimResult[] = [];
        for (const sot of sots) {
            for (const claim of sot.claims ?? []) {
                claims.push(this.verify(root, sot, claim));
            }
        }

        return {
            declared: sots.length > 0 || resources.length > 0,
            resources,
            sots,
            claims,
            invalid,
            withoutAuthority: resources.filter(r => !r.authority).map(r => r.id)
        };
    }

    async options(rootUri: string, sotId: string, claimId: string): Promise<ResolutionOption[]> {
        const { sot, claim } = await this.locate(rootUri, sotId, claimId);
        const options: ResolutionOption[] = [];
        // Mudar a implementação só é oferecido quando a afirmação diz literalmente
        // o que não pode estar lá: aí remover a linha é uma proposta legível.
        if (claim.check.kind === 'absent-in-file') {
            options.push({
                id: 'remove-offending-line',
                side: 'implementation',
                label: `Remover a linha divergente de ${claim.check.path}`,
                detail:
                    `Propõe apagar a(s) linha(s) que contêm "${claim.check.pattern}" em ` +
                    `${claim.check.path}. O diff vai ao broker para você decidir — e provavelmente ` +
                    'você quer editar à mão em vez de apagar; esta opção existe para o caso simples.'
            });
        }
        options.push({
            id: 'accept-exception',
            side: 'intent',
            label: 'Registrar exceção escopada no SoT',
            detail:
                `Propõe editar ${sot.manifestPath} anotando uma exceção justificada para esta ` +
                'afirmação. A afirmação continua valendo no resto do projeto, e a exceção fica ' +
                'em diff, com data — não vira silêncio.'
        });
        return options;
    }

    async resolve(
        rootUri: string,
        sotId: string,
        claimId: string,
        optionId: string
    ): Promise<{ proposalId: string; relPath: string }> {
        const root = this.rootPath(rootUri);
        const { sot, claim } = await this.locate(rootUri, sotId, claimId);

        if (optionId === 'remove-offending-line') {
            const target = this.confine(root, claim.check.path);
            const before = fs.readFileSync(target, 'utf8');
            const after = before
                .split('\n')
                .filter(line => !line.includes(claim.check.pattern))
                .join('\n');
            if (after === before) {
                throw new Error(
                    `nada a remover: "${claim.check.pattern}" não aparece em ${claim.check.path}`
                );
            }
            const proposal = await this.governed.proposeWrite(rootUri, claim.check.path, after);
            return { proposalId: proposal.id, relPath: proposal.relPath };
        }

        if (optionId === 'accept-exception') {
            const manifestRel = sot.manifestPath!;
            const next: SourceOfTruth = {
                ...sot,
                claims: sot.claims.map(c =>
                    c.id === claim.id
                        ? {
                            ...c,
                            exception: {
                                reason:
                                    `Exceção registrada pelo IDE para ${claim.check.path}. ` +
                                    'Edite este texto com o motivo real.',
                                at: new Date().toISOString()
                            }
                        }
                        : c
                )
            };
            delete next.manifestPath;
            const proposal = await this.governed.proposeWrite(
                rootUri,
                manifestRel,
                JSON.stringify(next, undefined, 2) + '\n'
            );
            return { proposalId: proposal.id, relPath: proposal.relPath };
        }

        throw new Error(`opção de resolução desconhecida: ${optionId}`);
    }

    async candidates(
        rootUri: string
    ): Promise<{ resources: ProjectResource[]; sots: SourceOfTruth[] }> {
        const root = this.rootPath(rootUri);
        const resources: ProjectResource[] = [];
        const sots: SourceOfTruth[] = [];

        // Um candidato de recurso por diretório de primeiro nível com arquivos de
        // código, mais um por documento de intenção reconhecível. Nada é gravado.
        for (const name of this.safeReaddir(root)) {
            if (SKIP_DIRS.has(name) || name.startsWith('.')) {
                continue;
            }
            const abs = path.join(root, name);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(abs);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                const files = this.safeReaddir(abs).filter(f => /\.(ts|tsx|js|py|rs|go|java)$/.test(f));
                if (files.length > 0) {
                    resources.push({
                        id: name,
                        label: name,
                        paths: files.map(f => path.join(name, f)),
                        consumers: []
                    });
                }
            }
        }

        // Documentos de intenção: nomes conhecidos primeiro, depois qualquer
        // markdown em `docs/` cujo nome fale de intenção/produto. Nada aqui grava.
        const named = ['docs/product-intent.md', 'PRODUCT.md', 'README.md'];
        const discovered = this.safeReaddir(path.join(root, 'docs'))
            .filter(f => f.endsWith('.md') && /intent|inten|produto|product/i.test(f))
            .map(f => path.join('docs', f));
        for (const rel of [...named, ...discovered]) {
            if (fs.existsSync(path.join(root, rel))) {
                sots.push({
                    id: 'intent',
                    label: 'Intenção do produto',
                    kind: 'intent',
                    path: rel,
                    authorityOver: resources.map(r => r.id),
                    claims: []
                });
                break;
            }
        }
        return { resources, sots };
    }

    async declareResource(rootUri: string, resource: ProjectResource): Promise<ProductModel> {
        const root = this.rootPath(rootUri);
        this.validateResource(resource);
        this.write(root, path.join(RESOURCE_DIR, `${resource.id}.json`), resource);
        return this.model(rootUri);
    }

    async declareSot(rootUri: string, sot: SourceOfTruth): Promise<ProductModel> {
        const root = this.rootPath(rootUri);
        this.validateSot(sot);
        this.write(root, path.join(SOT_DIR, `${sot.id}.json`), sot);
        return this.model(rootUri);
    }

    // ── verificação ────────────────────────────────────────────────────────

    /** Verifica uma afirmação contra o arquivo real. Nunca inventa conformidade. */
    protected verify(root: string, sot: SourceOfTruth, claim: Claim): ClaimResult {
        const base: Omit<ClaimResult, 'status' | 'evidence' | 'line'> = {
            sotId: sot.id,
            claimId: claim.id,
            statement: claim.statement,
            path: claim.check.path,
            affectedResources: sot.authorityOver ?? []
        };
        let absolute: string;
        try {
            absolute = this.confine(root, claim.check.path);
        } catch (err) {
            return {
                ...base,
                status: 'unknown',
                evidence: `caminho recusado: ${err instanceof Error ? err.message : String(err)}`
            };
        }
        if (!fs.existsSync(absolute)) {
            return {
                ...base,
                status: 'unknown',
                evidence: `${claim.check.path} não existe — a afirmação não pôde ser verificada`
            };
        }
        let content: string;
        try {
            const stat = fs.statSync(absolute);
            if (stat.size > MAX_READ_BYTES) {
                return {
                    ...base,
                    status: 'unknown',
                    evidence: `${claim.check.path} é maior que o limite de leitura (${MAX_READ_BYTES} bytes)`
                };
            }
            content = fs.readFileSync(absolute, 'utf8');
        } catch (err) {
            return {
                ...base,
                status: 'unknown',
                evidence: `${claim.check.path} ilegível: ${err instanceof Error ? err.message : String(err)}`
            };
        }

        const lines = content.split('\n');
        const index = lines.findIndex(line => line.includes(claim.check.pattern));
        const found = index >= 0;
        const wantsAbsent = claim.check.kind === 'absent-in-file';
        const satisfied = wantsAbsent ? !found : found;

        if (!satisfied && claim.exception) {
            return {
                ...base,
                status: 'excepted',
                line: found ? index + 1 : undefined,
                evidence:
                    `divergente, mas com exceção registrada em ${sot.manifestPath}: ` +
                    `"${claim.exception.reason}" (${claim.exception.at})`
            };
        }
        if (satisfied) {
            return {
                ...base,
                status: 'ok',
                evidence: wantsAbsent
                    ? `"${claim.check.pattern}" não aparece em ${claim.check.path}`
                    : `"${claim.check.pattern}" aparece em ${claim.check.path}:${index + 1}`
            };
        }
        return {
            ...base,
            status: 'divergent',
            line: found ? index + 1 : undefined,
            evidence: wantsAbsent
                ? `"${claim.check.pattern}" aparece em ${claim.check.path}:${index + 1}, e a afirmação diz que não deveria`
                : `"${claim.check.pattern}" não aparece em ${claim.check.path}, e a afirmação diz que deveria`
        };
    }

    // ── artefatos ──────────────────────────────────────────────────────────

    protected readAll<T extends { id: string; manifestPath?: string }>(
        root: string,
        dir: string,
        invalid: { path: string; reason: string }[],
        validate: (value: T) => void
    ): T[] {
        const absolute = path.join(root, dir);
        if (!fs.existsSync(absolute)) {
            return [];
        }
        const out: T[] = [];
        for (const name of this.safeReaddir(absolute).sort()) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const file = path.join(absolute, name);
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
                validate(parsed);
                parsed.manifestPath = path.relative(root, file);
                out.push(parsed);
            } catch (err) {
                // Artefato de alguém (ou de um agente): reportado, nunca corrigido
                // em silêncio e nunca derrubando o resto do modelo.
                invalid.push({
                    path: path.relative(root, file),
                    reason: err instanceof Error ? err.message : String(err)
                });
            }
        }
        return out;
    }

    protected write(root: string, rel: string, value: object): void {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const clone = { ...value } as { manifestPath?: string };
        delete clone.manifestPath;
        fs.writeFileSync(file, JSON.stringify(clone, undefined, 2) + '\n', 'utf8');
        // Artefato do projeto escrito pelo IDE: o observador precisa saber para não
        // reportar isso como escrita externa.
        this.ledger.note(root, rel, 'harness', 'artefato semântico gravado pelo IDE');
    }

    protected validateSot(sot: SourceOfTruth): void {
        if (!sot.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(sot.id)) {
            throw new Error('SoT precisa de um `id` válido para nome de arquivo');
        }
        if (!sot.path) {
            throw new Error(`SoT '${sot.id}' precisa declarar o \`path\` do documento`);
        }
        if (!['intent', 'schema', 'doc', 'code'].includes(sot.kind)) {
            throw new Error(`SoT '${sot.id}' tem \`kind\` desconhecido: ${sot.kind}`);
        }
        for (const claim of sot.claims ?? []) {
            if (!claim.id || !claim.statement) {
                throw new Error(`afirmação sem \`id\`/\`statement\` em '${sot.id}'`);
            }
            if (!claim.check || !claim.check.path || !claim.check.pattern) {
                throw new Error(
                    `afirmação '${claim.id}' precisa de \`check.path\` e \`check.pattern\` — ` +
                    'divergência é calculada, então sem check não há afirmação'
                );
            }
            if (!['absent-in-file', 'present-in-file'].includes(claim.check.kind)) {
                throw new Error(`afirmação '${claim.id}' tem \`check.kind\` desconhecido`);
            }
        }
    }

    protected validateResource(resource: ProjectResource): void {
        if (!resource.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(resource.id)) {
            throw new Error('recurso precisa de um `id` válido para nome de arquivo');
        }
        if (!Array.isArray(resource.paths) || resource.paths.length === 0) {
            throw new Error(`recurso '${resource.id}' precisa declarar ao menos um caminho`);
        }
    }

    protected async locate(
        rootUri: string,
        sotId: string,
        claimId: string
    ): Promise<{ sot: SourceOfTruth; claim: Claim }> {
        const model = await this.model(rootUri);
        const sot = model.sots.find(s => s.id === sotId);
        if (!sot) {
            throw new Error(`fonte da verdade desconhecida: ${sotId}`);
        }
        const claim = (sot.claims ?? []).find(c => c.id === claimId);
        if (!claim) {
            throw new Error(`afirmação desconhecida em '${sotId}': ${claimId}`);
        }
        return { sot, claim };
    }

    protected safeReaddir(dir: string): string[] {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }

    protected confine(root: string, rel: string): string {
        const absolute = path.resolve(root, rel);
        const relative = path.relative(root, absolute);
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`caminho '${rel}' escapa da raiz do projeto`);
        }
        return absolute;
    }

    protected rootPath(rootUri: string): string {
        if (!rootUri) {
            throw new Error('nenhum projeto aberto');
        }
        const raw = rootUri.includes('://') ? FileUri.fsPath(new URI(rootUri)) : rootUri;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`raiz de projeto inexistente: ${resolved}`);
        }
        return resolved;
    }
}
