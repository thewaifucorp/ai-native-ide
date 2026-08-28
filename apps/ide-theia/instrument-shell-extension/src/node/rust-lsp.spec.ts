// Dois pontos do cliente LSP que quebram calados quando estão errados: o
// enquadramento das mensagens e a diferença entre "a ferramenta existe" e "a
// ferramenta funciona". Os dois foram observados errados antes de existir teste.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RustLspServiceImpl } from './rust-lsp-service';

/** O estado mínimo de um servidor, como o enquadrador o usa. */
interface ServidorFalso {
    buffer: Buffer;
    diagnostics: Map<string, { message: string }[]>;
    open: Set<string>;
    ready: boolean;
    nextId: number;
    pending: Map<number, unknown>;
}

/** Acesso aos internos que o serviço protege — é onde o defeito mora. */
class Sonda extends RustLspServiceImpl {
    recebidas: Record<string, unknown>[] = [];

    servidorFalso(): ServidorFalso {
        return {
            buffer: Buffer.alloc(0),
            diagnostics: new Map(),
            open: new Set<string>(),
            ready: false,
            nextId: 1,
            pending: new Map()
        };
    }

    exporReceive(server: ServidorFalso, chunk: Buffer): void {
        (this as unknown as { receive(s: unknown, c: Buffer): void }).receive(server, chunk);
    }

    exporVersion(binario: string): string | undefined {
        return (this as unknown as { version(b: string): string | undefined }).version(binario);
    }

    // Registra o que chegou, e não chama o super: `handle` responde no stdin de
    // um processo que aqui não existe.
    protected handle(_server: never, message: Record<string, unknown>): void {
        this.recebidas.push(message);
    }
}

describe('RustLspServiceImpl — enquadramento LSP', () => {

    /// `Content-Length` é em BYTES. Medir com `String.length` corta a mensagem
    /// em qualquer texto acentuado — e mensagem de erro do rustc tem acento,
    /// aspa tipográfica e seta. O sintoma seria diagnóstico que às vezes chega e
    /// às vezes desaparece, que é pior do que nunca chegar.
    it('mede o corpo em bytes, não em caracteres', () => {
        const sonda = new Sonda();
        const server = sonda.servidorFalso();
        const corpo = JSON.stringify({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
                uri: 'file:///tmp/x.rs',
                diagnostics: [
                    {
                        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
                        severity: 1,
                        message: 'tipos incompatíveis: esperava `u64`, achou `&str` — não dá',
                        source: 'rustc'
                    }
                ]
            }
        });
        const bytes = Buffer.from(corpo, 'utf8');
        assert.ok(bytes.length > corpo.length, 'o corpo tem de conter acento, senão o teste é vazio');

        sonda.exporReceive(
            server,
            Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'ascii'), bytes])
        );

        assert.strictEqual(sonda.recebidas.length, 1, 'uma mensagem, inteira');
        const recebida = sonda.recebidas[0] as {
            params?: { diagnostics?: { message?: string }[] };
        };
        const mensagem = recebida.params?.diagnostics?.[0]?.message ?? '';
        assert.ok(
            mensagem.includes('não dá'),
            `a mensagem chegou inteira: ${mensagem}`
        );
    });

    it('junta mensagem partida em dois pedaços', () => {
        const sonda = new Sonda();
        const server = sonda.servidorFalso();
        const corpo = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: {} }), 'utf8');
        const inteiro = Buffer.concat([
            Buffer.from(`Content-Length: ${corpo.length}\r\n\r\n`, 'ascii'),
            corpo
        ]);
        // O TCP não respeita fronteira de mensagem: um chunk pode cortar o corpo
        // no meio, e um cliente que assume "um chunk = uma mensagem" perde tudo
        // a partir dali.
        sonda.exporReceive(server, inteiro.subarray(0, inteiro.length - 5));
        assert.strictEqual(sonda.recebidas.length, 0, 'incompleta ainda não é mensagem');
        sonda.exporReceive(server, inteiro.subarray(inteiro.length - 5));
        assert.strictEqual(sonda.recebidas.length, 1, 'completada, virou uma mensagem');
    });
});

describe('RustLspServiceImpl — existir não é funcionar', () => {

    /// O rustup instala um SHIM em `~/.cargo/bin/rust-analyzer` mesmo sem o
    /// componente. O arquivo existe, é executável, e responde
    /// `error: Unknown binary 'rust-analyzer'` — com código de saída ZERO.
    /// A primeira versão da detecção aceitou a existência do arquivo como prova
    /// e o resultado foi um servidor que morria na hora com a capability jurando
    /// estar pronta.
    it('recusa um shim que não se apresenta pelo nome', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-shim-'));
        const shim = path.join(dir, 'rust-analyzer');
        fs.writeFileSync(
            shim,
            '#!/bin/sh\necho "error: Unknown binary \'rust-analyzer\' in official toolchain"\nexit 0\n',
            { mode: 0o755 }
        );

        const sonda = new Sonda();

        assert.strictEqual(
            sonda.exporVersion(shim),
            undefined,
            'saída que não começa com `rust-analyzer` não é versão, mesmo com exit 0'
        );
    });

    it('aceita um binário que reporta versão', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-ok-'));
        const bom = path.join(dir, 'rust-analyzer');
        fs.writeFileSync(bom, '#!/bin/sh\necho "rust-analyzer 1.97.0 (2d8144b 2026-07-07)"\n', {
            mode: 0o755
        });

        const sonda = new Sonda();

        assert.match(sonda.exporVersion(bom) ?? '', /^rust-analyzer 1\.97\.0/);
    });
});
