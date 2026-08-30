// Liga o cliente LSP do backend ao editor: marcadores, hover, definição e
// completar em arquivos Rust.
//
// ── POR QUE AQUI, E NÃO NUMA EXTENSÃO VS CODE ─────────────────────────────
// Porque a extensão do rust-analyzer não ativa neste host de plugins — medido,
// com o binário no lugar. Registrar direto no Monaco é o caminho que este app
// controla, e é o mesmo que o resto do shell já usa para falar com o editor.
//
// ── DUAS REGRAS QUE ESTE ARQUIVO SEGUE ────────────────────────────────────
// Nada sobe sozinho: o servidor só é iniciado quando a pessoa ABRE um arquivo
// Rust, nunca ao abrir o projeto — subir processo é ato explícito, a mesma regra
// que o preview do §4 segue.
//
// E ausência é dita: quando o servidor não existe no ambiente, o editor não
// finge inteligência silenciosa. A capability `rust-lsp` mostra o estado e a
// ação de instalar, e aqui apenas nada acontece.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager, TextEditor } from '@theia/editor/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { RustLspService } from '../common/rust-lsp-protocol';

/** Dono dos marcadores que este cliente publica, separado de qualquer outro. */
const MARKER_OWNER = 'instrument-rust-analyzer';

/**
 * Intervalo entre leituras de diagnóstico.
 *
 * O rust-analyzer publica quando termina de compilar, o que leva segundos e
 * acontece várias vezes. Um canal de push do backend seria melhor e não existe
 * ainda; puxar a cada 1,5 s é o custo honesto disso, e para de puxar quando não
 * há arquivo Rust aberto.
 */
const POLL_MS = 1500;

@injectable()
export class RustLspContribution implements FrontendApplicationContribution {

    @inject(RustLspService) protected readonly lsp!: RustLspService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ProblemManager) protected readonly problemas!: ProblemManager;

    protected timer?: number;
    protected registrado = false;
    /** Arquivos já entregues ao servidor, para não abrir duas vezes. */
    protected readonly jaAbertos = new Set<string>();

    onStart(): void {
        // `onCreated` cobre o que a pessoa abre daqui pra frente. Editor
        // RESTAURADO do layout anterior não passa por lá, e `editors.all` em
        // `onStart` ainda está vazio porque o layout é restaurado depois — foi
        // exatamente por isso que a primeira versão disto não ligava nada ao
        // reabrir a IDE com um arquivo Rust já aberto.
        this.editors.onCreated(widget => void this.aoAbrir(widget.editor));
        this.editors.onCurrentEditorChanged(widget => {
            if (widget) {
                void this.aoAbrir(widget.editor);
            }
        });
    }

    onDidInitializeLayout(): void {
        for (const widget of this.editors.all) {
            void this.aoAbrir(widget.editor);
        }
    }

    protected get rootUri(): string | undefined {
        return this.workspace.tryGetRoots()[0]?.resource.toString();
    }

    protected ehRust(editor: TextEditor): boolean {
        return editor.uri.path.ext === '.rs';
    }

    protected async aoAbrir(editor: TextEditor): Promise<void> {
        const root = this.rootUri;
        if (!this.ehRust(editor)) {
            return;
        }
        if (!root) {
            console.info('[rust-lsp] arquivo Rust aberto sem workspace: nada a analisar');
            return;
        }
        const chave = editor.uri.toString();
        if (this.jaAbertos.has(chave)) {
            return;
        }
        this.jaAbertos.add(chave);
        this.registrarProviders();
        try {
            const status = await this.lsp.open(root, editor.uri.toString(), editor.document.getText());
            if (!status.running) {
                // Ausência de servidor no ambiente NÃO é erro do projeto — a
                // capability `rust-lsp` é quem diz o estado e oferece instalar.
                // Mas ela também não pode ser silêncio total: sem esta linha, a
                // diferença entre "não tem rust-analyzer" e "o cliente quebrou"
                // fica invisível, e foi exatamente isso que me cegou ao ligar
                // este arquivo pela primeira vez.
                console.info(
                    `[rust-lsp] servidor não está de pé para ${root}: ${status.probe.detail}`
                );
                return;
            }
        } catch (err) {
            console.error('[rust-lsp] o cliente não conseguiu abrir o arquivo no servidor:', err);
            return;
        }
        // Mudança no documento vai para o servidor, senão o diagnóstico fica
        // falando de um texto que já não existe — pior que não ter diagnóstico.
        //
        // A escuta é no MODELO do Monaco, não no documento do Theia: o segundo
        // não expõe mudança de conteúdo nesta versão, e inventar um polling do
        // texto seria caro e atrasado.
        const model = monaco.editor.getModel(monaco.Uri.parse(editor.uri.toString()));
        model?.onDidChangeContent(() => {
            void this.lsp.change(root, editor.uri.toString(), model.getValue());
        });
        this.iniciarLeitura(root);
    }

    protected iniciarLeitura(root: string): void {
        if (this.timer !== undefined) {
            return;
        }
        this.timer = window.setInterval(() => void this.puxarDiagnosticos(root), POLL_MS);
        void this.puxarDiagnosticos(root);
    }

    protected async puxarDiagnosticos(root: string): Promise<void> {
        let diagnosticos;
        try {
            diagnosticos = await this.lsp.diagnostics(root);
        } catch {
            return;
        }
        // Agrupa por arquivo: `setModelMarkers` substitui TUDO daquele dono
        // naquele modelo, então mandar por arquivo é o que evita um arquivo
        // apagar os marcadores do outro.
        const porArquivo = new Map<string, typeof diagnosticos>();
        for (const d of diagnosticos) {
            const lista = porArquivo.get(d.fsPath) ?? [];
            lista.push(d);
            porArquivo.set(d.fsPath, lista);
        }
        for (const model of monaco.editor.getModels()) {
            if (model.uri.path.endsWith('.rs') !== true) {
                continue;
            }
            const lista = porArquivo.get(model.uri.fsPath) ?? [];
            monaco.editor.setModelMarkers(
                model,
                MARKER_OWNER,
                lista.map(d => ({
                    // O LSP conta de 0, a pessoa lê de 1, e o Monaco conta de 1.
                    startLineNumber: d.line,
                    startColumn: d.column,
                    endLineNumber: d.endLine,
                    endColumn: d.endColumn,
                    message: d.source ? `${d.message}\n\n— ${d.source}` : d.message,
                    severity: this.severidade(d.severity)
                }))
            );
            // O rabisco vermelho no editor NÃO alimenta o contador da barra de
            // status nem a lista de Problemas: essas duas leem o ProblemManager
            // do Theia, e este cliente escreve direto no Monaco. Sem publicar
            // aqui também, o rodapé dizia "0 erros" com dois rabiscos na tela —
            // e a barra é onde se olha para saber se o projeto está são.
            this.problemas.setMarkers(
                new URI(model.uri.toString()),
                MARKER_OWNER,
                lista.map(d => ({
                    range: {
                        // O ProblemManager fala LSP: linha e coluna contam de 0.
                        start: { line: d.line - 1, character: d.column - 1 },
                        end: { line: d.endLine - 1, character: d.endColumn - 1 }
                    },
                    message: d.message,
                    severity: this.severidadeLsp(d.severity),
                    source: d.source
                }))
            );
        }
    }

    /** Severidade no vocabulário do LSP, que é o que o ProblemManager guarda. */
    protected severidadeLsp(nome: string): 1 | 2 | 3 | 4 {
        switch (nome) {
            case 'error':
                return 1;
            case 'warning':
                return 2;
            case 'information':
                return 3;
            default:
                return 4;
        }
    }

    protected severidade(nome: string): monaco.MarkerSeverity {
        switch (nome) {
            case 'error':
                return monaco.MarkerSeverity.Error;
            case 'warning':
                return monaco.MarkerSeverity.Warning;
            case 'information':
                return monaco.MarkerSeverity.Info;
            default:
                return monaco.MarkerSeverity.Hint;
        }
    }

    /**
     * Registra hover, definição e completar — uma vez por sessão.
     *
     * Registrar por arquivo aberto duplicaria os provedores e a pessoa veria o
     * mesmo tipo repetido no hover, que é o tipo de defeito que faz a ferramenta
     * parecer quebrada mesmo funcionando.
     */
    protected registrarProviders(): void {
        if (this.registrado) {
            return;
        }
        this.registrado = true;
        const rootDe = () => this.rootUri;

        monaco.languages.registerHoverProvider('rust', {
            provideHover: async (model, position) => {
                const root = rootDe();
                if (!root) {
                    return undefined;
                }
                const hover = await this.lsp
                    .hover(root, model.uri.toString(), {
                        line: position.lineNumber,
                        column: position.column
                    })
                    .catch(() => undefined);
                return hover && hover.markdown
                    ? { contents: [{ value: hover.markdown }] }
                    : undefined;
            }
        });

        monaco.languages.registerDefinitionProvider('rust', {
            provideDefinition: async (model, position) => {
                const root = rootDe();
                if (!root) {
                    return undefined;
                }
                const alvos = await this.lsp
                    .definition(root, model.uri.toString(), {
                        line: position.lineNumber,
                        column: position.column
                    })
                    .catch(() => []);
                return alvos.map(alvo => ({
                    uri: monaco.Uri.file(alvo.fsPath),
                    range: {
                        startLineNumber: alvo.line,
                        startColumn: alvo.column,
                        endLineNumber: alvo.line,
                        endColumn: alvo.column
                    }
                }));
            }
        });

        monaco.languages.registerCompletionItemProvider('rust', {
            // `.` e `:` são onde completar importa em Rust (campo, método, path).
            triggerCharacters: ['.', ':'],
            provideCompletionItems: async (model, position) => {
                const root = rootDe();
                if (!root) {
                    return { suggestions: [] };
                }
                const itens = await this.lsp
                    .completion(root, model.uri.toString(), {
                        line: position.lineNumber,
                        column: position.column
                    })
                    .catch(() => []);
                const palavra = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: palavra.startColumn,
                    endColumn: palavra.endColumn
                };
                return {
                    suggestions: itens.map(item => ({
                        label: item.label,
                        kind: this.tipoDeItem(item.kind),
                        detail: item.detail,
                        insertText: item.insertText ?? item.label,
                        range
                    }))
                };
            }
        });
    }

    protected tipoDeItem(kind: string): monaco.languages.CompletionItemKind {
        const K = monaco.languages.CompletionItemKind;
        switch (kind) {
            case 'method':
                return K.Method;
            case 'function':
                return K.Function;
            case 'field':
                return K.Field;
            case 'variable':
                return K.Variable;
            case 'struct':
                return K.Struct;
            case 'enum':
                return K.Enum;
            case 'enum-member':
                return K.EnumMember;
            case 'module':
                return K.Module;
            case 'keyword':
                return K.Keyword;
            case 'constant':
                return K.Constant;
            case 'interface':
                return K.Interface;
            case 'type-parameter':
                return K.TypeParameter;
            default:
                return K.Text;
        }
    }
}
