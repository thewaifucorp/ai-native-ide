// ANALISAR PROJETO E MATERIAIS (§5) — contrato compartilhado.
//
// ── O QUE É, E O QUE DELIBERADAMENTE NÃO É ────────────────────────────────
// Isto LÊ o projeto e devolve CANDIDATOS: stack, comandos, Git, serviços e
// integrações. Candidato não é ativação. Nada é gravado, nada é ligado, nada
// muda de comportamento porque a análise rodou — alguém aceita, explicitamente,
// e só então existe efeito.
//
// A regra vem do embrião que já existia (`ProductService.candidates`, PROJ-06):
// detectar sem gravar. O que faltava lá, e é o coração do §5, é PROVENANCE.
//
// ── POR QUE PROVENANCE É O PONTO, E NÃO ENFEITE ───────────────────────────
// "Este projeto usa Rust" é uma afirmação. Sem dizer de onde veio, é
// indistinguível de um palpite — e um palpite de detector é exatamente o tipo de
// confiança inventada que o resto do IDE recusa (`unknown` nunca vira verde).
// Então toda afirmação aqui carrega o arquivo, a linha quando existe, e o
// trecho observado. Quem revisa consegue conferir sem confiar em mim.
//
// Um corolário que o formato impõe: se não dá para apontar a evidência, o
// candidato não é emitido. Não há campo "inferido", "provável" ou "heurística".
//
// ── LIGAÇÃO COM O §4 ──────────────────────────────────────────────────────
// Os candidatos de comando têm destino concreto: `.instrument/checks.json`, o
// arquivo que os checks determinísticos leem. O §4 decidiu de propósito não
// detectar comando nenhum, para não duplicar isto com uma versão pior. Aqui a
// detecção acontece uma vez, com evidência, e a adoção é um ato explícito.

/** JSON-RPC path do serviço de análise. */
export const ANALYSIS_SERVICE_PATH = '/services/analysis';

/** Símbolo de DI; funde com a interface abaixo. */
export const AnalysisService = Symbol('AnalysisService');

/**
 * De onde veio uma afirmação.
 *
 * `excerpt` é texto realmente lido do arquivo, nunca uma reescrita. É o que
 * permite conferir a afirmação sem abrir o projeto.
 */
export interface Provenance {
    /** Caminho relativo à raiz do projeto. */
    path: string;
    /** Linha 1-based, quando a evidência é uma linha específica. */
    line?: number;
    /** Trecho observado, cortado no comprimento mas nunca reescrito. */
    excerpt: string;
}

/** Uma tecnologia detectada, com o que a sustenta. */
export interface StackCandidate {
    id: string;
    label: string;
    /** Pelo menos uma. Um candidato sem evidência não é emitido. */
    provenance: Provenance[];
}

/** Um comando que o projeto declara para si mesmo. */
export interface CommandCandidate {
    /** Papel no vocabulário do §4. */
    slug: 'build' | 'test' | 'typecheck' | 'start' | 'lint';
    command: string;
    /** Relativo à raiz, quando o comando pertence a um subprojeto. */
    cwd?: string;
    provenance: Provenance;
    /** Já declarado em `.instrument/checks.json` — adotar não mudaria nada. */
    alreadyDeclared: boolean;
    /**
     * Os checks do §4 executam este papel.
     *
     * Só `build`, `test` e `typecheck` são executados. `start` e `lint` são
     * detectados porque descrevem o projeto, mas adotá-los escreveria uma chave
     * que o motor ignora — então a tela não oferece adoção para eles, em vez de
     * oferecer e recusar depois.
     */
    runnableByChecks: boolean;
}

/** Fatos de Git, todos verificáveis. */
export interface GitFacts {
    isRepo: boolean;
    branch?: string;
    /** Nome e URL de cada remoto, como o config declara. */
    remotes: { name: string; url: string }[];
    provenance: Provenance[];
}

/** Um serviço que o projeto espera ter por perto. */
export interface ServiceCandidate {
    id: string;
    label: string;
    /** `container` (compose), `database` (URL de conexão), `http` (endpoint). */
    kind: 'container' | 'database' | 'http';
    provenance: Provenance;
}

/** Uma integração externa declarada pelo projeto. */
export interface IntegrationCandidate {
    id: string;
    label: string;
    /** `ci`, `mcp` (servidor de ferramentas para agente), `container`. */
    kind: 'ci' | 'mcp' | 'container';
    provenance: Provenance;
}

/**
 * Um arquivo de instruções que o projeto mantém para quem trabalha nele.
 *
 * Detectado por NOME, que é a convenção pública dessas ferramentas — não por
 * heurística de conteúdo. `bytes` e `headings` existem para "eu li isto" ser
 * mensurável em vez de afirmado.
 */
export interface InstructionCandidate {
    id: string;
    label: string;
    /** `agent` (AGENTS.md, CLAUDE.md, .cursorrules…), `contribution`, `editor`. */
    kind: 'agent' | 'contribution' | 'editor';
    bytes: number;
    /** Títulos de seção lidos, na ordem do arquivo. */
    headings: string[];
    provenance: Provenance;
}

/**
 * Uma orientação candidata, extraída de um arquivo de instruções.
 *
 * `strength` é SEMPRE `suggestion`. Um detector não tem como saber que uma frase
 * é bloqueante — quem escreveu sabe, e quem revisa decide. Emitir `blocking`
 * por detecção transformaria palpite em regra que trava trabalho.
 *
 * Adotar grava em `.product/guidance/`, que é CONTEÚDO DO PROJETO — e por isso
 * passa pelo broker, ao contrário de `.instrument/`, que é estado de runtime do
 * IDE.
 */
export interface GuidanceCandidate {
    id: string;
    title: string;
    strength: 'suggestion';
    /** Trecho lido do arquivo, verbatim (cortado no comprimento). */
    text: string;
    provenance: Provenance;
    /** Caminho que a adoção propõe escrever. */
    target: string;
    /** Já existe arquivo de guidance com este id. */
    alreadyDeclared: boolean;
}

/**
 * Uma configuração do IDE que o projeto já tem como declarar.
 *
 * `proposed` é exatamente o objeto que a adoção grava — nada é montado depois,
 * então o que está na tela é o que vai para o disco. `gap` diz o que a
 * configuração ainda não tem, quando falta algo, em vez de gravar um buraco
 * silencioso.
 */
export interface ConfigCandidate {
    id: string;
    /** Arquivo relativo à raiz, sempre dentro de `.instrument/`. */
    target: string;
    label: string;
    proposed: Record<string, unknown>;
    /** Uma por afirmação dentro de `proposed`. */
    provenance: Provenance[];
    alreadyDeclared: boolean;
    gap?: string;
}

/**
 * Uma referência que o projeto cita: URL externa ou arquivo do próprio projeto.
 *
 * O item §5 pede que "assets fiquem no workspace". Um arquivo citado que existe
 * no projeto JÁ é um asset versionado, e `presentInWorkspace` diz isso. Uma URL
 * externa não é baixada: este serviço não tem rede, e inventar um asset local a
 * partir de um link seria afirmar conteúdo que ninguém buscou. `assetNote` diz
 * qual dos dois casos é.
 */
export interface ReferenceCandidate {
    id: string;
    kind: 'url' | 'file';
    /** URL, ou caminho relativo à raiz. */
    target: string;
    label: string;
    provenance: Provenance;
    presentInWorkspace: boolean;
    assetNote?: string;
    /** Já registrada em `.product/references/`. */
    alreadyRegistered: boolean;
}

/**
 * Uma relação entre dois materiais, e o trecho que a sustenta.
 *
 * Só relação LITERAL: um arquivo cita um caminho que existe, um script, ou o
 * nome de uma variável de serviço detectada. Não há inferência semântica aqui —
 * seria a mesma confiança inventada que o resto do §5 recusa.
 */
export interface RelationCandidate {
    id: string;
    /** Material de origem, ex. `instruction:AGENTS.md`. */
    from: string;
    /** Material de destino, ex. `file:src/main.ts` ou `command:test`. */
    to: string;
    kind: 'menciona-arquivo' | 'menciona-comando' | 'menciona-servico';
    provenance: Provenance;
}

export interface ProjectAnalysis {
    stack: StackCandidate[];
    commands: CommandCandidate[];
    git: GitFacts;
    services: ServiceCandidate[];
    integrations: IntegrationCandidate[];
    instructions: InstructionCandidate[];
    guidance: GuidanceCandidate[];
    config: ConfigCandidate[];
    references: ReferenceCandidate[];
    relations: RelationCandidate[];
    /** Diretórios que a varredura não abriu, ditos para a cobertura ser honesta. */
    skipped: string[];
    /**
     * Limites que a varredura atingiu (arquivos lidos, candidatos cortados).
     *
     * Uma lista truncada em silêncio parece cobertura completa. Cada corte é
     * dito aqui, com o número.
     */
    limits: string[];
}

export interface AnalysisService {
    /**
     * Lê o projeto e devolve candidatos com evidência. Não grava nada e não
     * ativa nada; chamar duas vezes não tem efeito colateral nenhum.
     */
    analyze(rootUri: string): Promise<ProjectAnalysis>;

    /**
     * Adota comandos, escrevendo `.instrument/checks.json`.
     *
     * Escreve direto, sem passar pelo broker, e isso é deliberado: `.instrument/`
     * é estado de runtime do IDE (ignorado pelo git), não conteúdo do projeto —
     * o mesmo lugar onde o observador guarda a baseline dele. O broker governa
     * escrita em ARQUIVO DO PROJETO, e usar ele aqui transformaria configuração
     * do IDE em mudança de código para revisar.
     *
     * O que protege esta escrita é ser explícita: só acontece quando alguém
     * adota, nomeando quais slugs. Adotar de novo sobrescreve só os slugs
     * pedidos, preservando o que já estava declarado à mão.
     */
    adoptCommands(rootUri: string, slugs: string[]): Promise<ProjectAnalysis>;

    /**
     * Adota uma configuração candidata, gravando o `proposed` dela.
     *
     * Mesmo regime de `adoptCommands`: destino em `.instrument/`, escrita direta,
     * porque é estado de runtime do IDE e não conteúdo do projeto. Preserva as
     * chaves que já estavam no arquivo.
     */
    adoptConfig(rootUri: string, id: string): Promise<ProjectAnalysis>;

    /**
     * Propõe adotar uma guidance, escrevendo em `.product/guidance/`.
     *
     * Aqui o regime é o OUTRO: `.product/` é conteúdo do projeto, versionado e
     * revisável, então a escrita atravessa o broker e vira decisão no dock — não
     * um arquivo que apareceu. Devolve a proposta, não o arquivo.
     */
    proposeGuidance(rootUri: string, id: string): Promise<{ proposalId: string; relPath: string }>;

    /**
     * Propõe registrar uma referência em `.product/references/`.
     *
     * Também via broker, e pelo mesmo motivo. O registro guarda a procedência —
     * onde a referência foi citada — e, para arquivo do projeto, o caminho do
     * asset que já está versionado aqui. URL externa não é baixada.
     */
    registerReference(rootUri: string, id: string): Promise<{ proposalId: string; relPath: string }>;
}
