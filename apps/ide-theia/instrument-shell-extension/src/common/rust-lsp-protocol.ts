// Inteligência de Rust no editor — sem passar pelo host de plugins.
//
// ── POR QUE ESTE SERVIÇO EXISTE ────────────────────────────────────────────
// O caminho óbvio era embarcar a extensão `rust-lang.rust-analyzer`. Foi tentado
// e medido: o vsix do open-vsx não traz o binário do servidor, e — o que mata a
// ideia — a ativação falha no host de plugins desta versão do Theia com
// `Pending response rejected since connection got disposed`, mesmo depois de
// colocar o binário exatamente onde a extensão o procura. O resultado na tela
// eram três avisos vermelhos e nenhuma análise.
//
// Então o cliente é nosso: o backend fala LSP direto com o `rust-analyzer` da
// máquina e entrega diagnóstico ao editor. Isso troca uma dependência que não
// funciona por um contrato pequeno que funciona, e mantém a regra do §1 — a
// ferramenta externa é uma CAPABILITY, com estado honesto e ação de instalar,
// nunca uma suposição.
//
// ── O QUE ESTA FATIA FAZ, E O QUE NÃO FAZ ─────────────────────────────────
// Faz: encontra o servidor de forma portátil, sobe um por projeto, abre os
// arquivos Rust que a pessoa abre e publica os diagnósticos que o servidor
// reportar (que é de onde vêm os erros de compilação de verdade).
//
// Faz também o que uma pessoa usa a cada minuto: hover com o tipo, ir para a
// definição e completar. Cada um é um pedido LSP com resposta correlacionada por
// id — sem isso, "temos LSP" seria só diagnóstico e a palavra prometeria mais do
// que entrega.
//
// Não faz: renomear, ações de código e formatação. A ausência é dita na
// capability em vez de ser insinuada como pronta.

export const RUST_LSP_SERVICE_PATH = '/services/instrument-rust-lsp';
export const RustLspService = Symbol('RustLspService');

/** Onde o servidor foi achado, ou por que não foi. */
export interface RustLspProbe {
    /** Caminho absoluto do binário, quando existe. */
    path?: string;
    /** `rust-analyzer 1.90.0 (…)` como o próprio binário se apresenta. */
    version?: string;
    /**
     * Como foi achado: `path`, `rustup`, `cargo-home` ou `não encontrado`.
     *
     * Dizer ONDE foi achado importa: duas máquinas com resultados diferentes
     * viram uma diferença explicável em vez de mistério.
     */
    source: string;
    /** `rustup` existe nesta máquina — decide se instalar é oferecível. */
    rustupAvailable: boolean;
    /** Frase honesta para a capability. Nunca vazia. */
    detail: string;
}

/** Um diagnóstico do servidor, no mínimo que o editor precisa para marcar. */
export interface RustDiagnostic {
    /** Caminho absoluto do arquivo a que este diagnóstico pertence. */
    fsPath: string;
    /** Linha 1-based, como a pessoa lê. */
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    /** `error` | `warning` | `information` | `hint`. */
    severity: string;
    message: string;
    /** `rust-analyzer`, `rustc`, `clippy`… como o servidor declarou. */
    source?: string;
}

export interface RustLspStatus {
    /** Um servidor está de pé para este projeto. */
    running: boolean;
    /** Ele terminou o carregamento do workspace (`cargo metadata` etc). */
    ready: boolean;
    /** O último erro observado, verbatim. Silêncio aqui significa sem erro. */
    problem?: string;
    /** Quantos arquivos estão abertos no servidor. */
    openFiles: number;
    probe: RustLspProbe;
}

/** Uma posição no arquivo, 1-based como a pessoa lê. */
export interface RustPosition {
    line: number;
    column: number;
}

/** O que o servidor respondeu para um hover. */
export interface RustHover {
    /** Markdown como o servidor mandou. Vazio = nada a dizer ali. */
    markdown: string;
}

/** Um destino de "ir para a definição". */
export interface RustLocation {
    fsPath: string;
    line: number;
    column: number;
}

/** Um item de completar, no mínimo que o editor precisa. */
export interface RustCompletion {
    label: string;
    /** `function`, `struct`, `method`… como o servidor classificou. */
    kind: string;
    detail?: string;
    /** O texto a inserir, quando difere do label. */
    insertText?: string;
}

export interface RustLspService {
    /** Procura o servidor. Nunca instala nada e nunca sobe processo. */
    probe(): Promise<RustLspProbe>;

    /**
     * Instala via `rustup component add rust-analyzer`.
     *
     * Ato explícito: subir servidor e instalar componente são coisas que a
     * pessoa pede, não efeitos de abrir um arquivo.
     */
    install(): Promise<RustLspProbe>;

    /** Sobe (ou reaproveita) o servidor do projeto e abre um arquivo nele. */
    open(rootUri: string, fileUri: string, text: string): Promise<RustLspStatus>;

    /** Reenvia o conteúdo atual de um arquivo já aberto. */
    change(rootUri: string, fileUri: string, text: string): Promise<void>;

    /** Diagnósticos publicados até agora para este projeto. */
    diagnostics(rootUri: string): Promise<RustDiagnostic[]>;

    /** O tipo/documentação sob o cursor, ou vazio quando não há nada ali. */
    hover(rootUri: string, fileUri: string, at: RustPosition): Promise<RustHover | undefined>;

    /** Para onde "ir para a definição" leva. Lista vazia = servidor não sabe. */
    definition(rootUri: string, fileUri: string, at: RustPosition): Promise<RustLocation[]>;

    /** O que completar naquela posição. */
    completion(rootUri: string, fileUri: string, at: RustPosition): Promise<RustCompletion[]>;

    /** Derruba o servidor deste projeto. */
    stop(rootUri: string): Promise<RustLspStatus>;
}
