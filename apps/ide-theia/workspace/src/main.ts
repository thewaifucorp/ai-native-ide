// Runnable entry for the demo auction: node runs this .ts file directly (Node 22
// strips the types), so the IDE can launch/debug the real project with no build
// step in between. Breakpoints belong on the ranking call and inside `rank`.

import { rank } from './auction.ts';
import type { Bid } from './auction.ts';

const bids: Bid[] = [
    { id: 'bid-a', campaignId: 'campanha-1', sealedAmount: 1200, createdAt: 3 },
    { id: 'bid-b', campaignId: 'campanha-1', sealedAmount: 4800, createdAt: 1 },
    { id: 'bid-c', campaignId: 'campanha-1', sealedAmount: 4800, createdAt: 2 }
];

const ranked = rank(bids);
const winner = ranked[0];

console.log(`lances recebidos: ${bids.length}`);
for (const bid of ranked) {
    console.log(`  ${bid.id} · ${bid.sealedAmount} · criado em ${bid.createdAt}`);
}
console.log(`vencedor: ${winner.id} (${winner.sealedAmount})`);
