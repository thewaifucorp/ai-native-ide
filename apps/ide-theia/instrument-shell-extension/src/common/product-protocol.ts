// PROJETO SEMÂNTICO E SoTs (TASKS.md §3, PROJ-01..06, INTN-05).
//
// O que este contrato resolve: hoje o IDE conhece arquivos. Um projeto tem
// RECURSOS (coisas que existem: um módulo, um documento, um serviço), cada um com
// uma AUTORIDADE (qual fonte da verdade decide o que é certo sobre ele) e
// CONSUMIDORES (quem depende dele). A pergunta que importa — "a implementação
// concorda com a intenção?" — só existe quando isso está declarado.
//
// ── ARTEFATOS, NÃO OBJETOS EM MEMÓRIA ─────────────────────────────────────
// Tudo aqui é arquivo versionado em `.product/`, do mesmo jeito que o harness:
//
//   .product/sot/<id>.json          fonte da verdade: o que ela declara e como checar
//   .product/resources/<id>.json    recurso: caminhos, autoridade, consumidores
//
// Pessoa e agente escrevem nos mesmos arquivos. O IDE lê o que está no disco.
//
// ── DIVERGÊNCIA É CALCULADA, NUNCA DECLARADA ──────────────────────────────
// Um SoT declara AFIRMAÇÕES (`claims`) com um check verificável sobre arquivos
// reais. Divergência é uma afirmação cujo check falhou. Ninguém escreve
// "divergente: sim" num arquivo — se a afirmação passa, não há divergência; se o
// check não pode rodar (arquivo ausente, padrão inválido), o resultado é
// `unknown`, e `unknown` nunca aparece como conformidade.
//
// ── RESOLUÇÃO PASSA PELO BROKER ───────────────────────────────────────────
// Resolver uma divergência é escolher um lado: mudar a implementação ou mudar a
// intenção. As duas saídas são propostas de escrita pelo broker, com diff,
// aprovação, snapshot e rollback. O IDE não conserta nada sozinho e não deixa
// "aceitar exceção" virar silêncio: exceção escopada é uma edição do próprio SoT,
// portanto revisável em diff.

/** JSON-RPC path do serviço de projeto semântico. */
export const PRODUCT_SERVICE_PATH = '/services/product';

/** Símbolo de DI; casa com a interface abaixo. */
export const ProductService = Symbol('ProductService');

/** Diretório versionado dos artefatos semânticos, relativo à raiz do projeto. */
export const PRODUCT_DIR = '.product';

/** Como uma afirmação é verificada contra o projeto real. */
export type ClaimCheckKind =
    /** O padrão NÃO pode aparecer no arquivo (ex: desempate por ordem de criação). */
    | 'absent-in-file'
    /** O padrão TEM de aparecer no arquivo. */
    | 'present-in-file';

export interface ClaimCheck {
    kind: ClaimCheckKind;
    /** Caminho relativo à raiz do projeto. */
    path: string;
    /** Texto literal procurado (não regex: evita afirmação que ninguém entende). */
    pattern: string;
}

/** Uma afirmação de uma fonte da verdade sobre o projeto. */
export interface Claim {
    id: string;
    /** A afirmação em linguagem de produto, do jeito que uma pessoa a leria. */
    statement: string;
    check: ClaimCheck;
    /**
     * Exceção escopada e justificada: a afirmação continua valendo, mas este
     * caminho está deliberadamente fora dela. Fica no artefato, em diff.
     */
    exception?: { reason: string; at: string };
}

/** Uma fonte da verdade declarada do projeto. */
export interface SourceOfTruth {
    id: string;
    label: string;
    /** `intent` (o que o produto quer), `schema`, `doc`, `code`. */
    kind: 'intent' | 'schema' | 'doc' | 'code';
    /** Onde a fonte vive — o documento que uma pessoa edita. */
    path: string;
    /** Ids de recursos sobre os quais esta fonte tem autoridade. */
    authorityOver: string[];
    claims: Claim[];
    /** Caminho do artefato que declarou isso (preenchido na leitura). */
    manifestPath?: string;
}

/** Um recurso real do projeto. */
export interface ProjectResource {
    id: string;
    label: string;
    /** Arquivos/diretórios que materializam o recurso. */
    paths: string[];
    /** Id do SoT que decide o que é certo sobre ele; vazio = sem autoridade. */
    authority?: string;
    /** Ids de recursos que dependem deste. */
    consumers: string[];
    manifestPath?: string;
}

export type ClaimStatus = 'ok' | 'divergent' | 'unknown' | 'excepted';

/** Resultado da verificação de uma afirmação contra o projeto real. */
export interface ClaimResult {
    sotId: string;
    claimId: string;
    statement: string;
    status: ClaimStatus;
    /** Evidência: o que foi olhado e o que foi encontrado. Nunca vazio. */
    evidence: string;
    /** Caminho verificado, para abrir no editor. */
    path: string;
    /** Linha onde o padrão foi encontrado, quando aplicável. */
    line?: number;
    /** Ids de recursos afetados, via autoridade do SoT. */
    affectedResources: string[];
}

/** Um caminho de resolução oferecido para uma divergência. */
export interface ResolutionOption {
    id: string;
    /** `implementation` muda o código; `intent` muda a fonte da verdade. */
    side: 'implementation' | 'intent';
    label: string;
    /** O que exatamente será proposto ao broker. */
    detail: string;
}

/** O modelo semântico inteiro do projeto, como está no disco agora. */
export interface ProductModel {
    /** True quando existe pelo menos um artefato em `.product/`. */
    declared: boolean;
    resources: ProjectResource[];
    sots: SourceOfTruth[];
    /** Resultado de cada afirmação — a única fonte de "divergência". */
    claims: ClaimResult[];
    /** Artefatos ilegíveis, com o motivo. Mostrado, não escondido. */
    invalid: { path: string; reason: string }[];
    /** Recursos sem autoridade declarada — lacuna honesta, não erro. */
    withoutAuthority: string[];
}

export interface ProductService {
    /** Lê os artefatos e verifica todas as afirmações. Não escreve nada. */
    model(rootUri: string): Promise<ProductModel>;

    /** Caminhos de resolução para uma divergência específica. */
    options(rootUri: string, sotId: string, claimId: string): Promise<ResolutionOption[]>;

    /**
     * Propõe a resolução escolhida PELO BROKER. Devolve o id da proposta
     * aguardando decisão — nada é escrito por esta chamada.
     */
    resolve(
        rootUri: string,
        sotId: string,
        claimId: string,
        optionId: string
    ): Promise<{ proposalId: string; relPath: string }>;

    /**
     * Analisa o projeto e devolve CANDIDATOS de recurso/SoT a partir do que
     * existe de fato (PROJ-06). Candidato não é ativação: nada é gravado até
     * alguém aceitar, e aceitar é uma escrita de artefato.
     */
    candidates(rootUri: string): Promise<{ resources: ProjectResource[]; sots: SourceOfTruth[] }>;

    /** Grava um artefato de recurso ou SoT (equivale a escrever o arquivo). */
    declareResource(rootUri: string, resource: ProjectResource): Promise<ProductModel>;
    declareSot(rootUri: string, sot: SourceOfTruth): Promise<ProductModel>;
}
