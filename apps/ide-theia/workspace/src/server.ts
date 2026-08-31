// Preview do projeto de demonstração: o leaderboard público do leilão.
//
// Existe para o §4 ter um preview REAL para supervisionar — um processo que sobe,
// responde uma url de saúde, e pode quebrar de verdade. Node 22 roda este .ts
// direto, então não há build entre o arquivo e o processo.
//
// A rota pública respeita a regra do domínio: o leaderboard NÃO expõe o id do
// lance. Quem quiser conferir compara com `src/auction.ts`.

import { createServer } from 'node:http';
import { rank } from './auction.ts';
import type { Bid } from './auction.ts';

const PORT = Number(process.env.PORT ?? 8787);

const bids: Bid[] = [
    { id: 'bid-a', campaignId: 'campanha-1', sealedAmount: 1200, createdAt: 3 },
    { id: 'bid-b', campaignId: 'campanha-1', sealedAmount: 4800, createdAt: 1 },
    { id: 'bid-c', campaignId: 'campanha-1', sealedAmount: 4800, createdAt: 2 }
];

const server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url.startsWith('/health')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, bids: bids.length }));
        return;
    }
    if (url.startsWith('/leaderboard')) {
        // Sem `id`: a listagem pública não vaza identidade de lance.
        const rows = rank(bids).map((bid, index) => ({
            position: index + 1,
            campaignId: bid.campaignId,
            sealedAmount: bid.sealedAmount
        }));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(rows));
        return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('rota inexistente\n');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`leaderboard ouvindo em http://127.0.0.1:${PORT}`);
});
