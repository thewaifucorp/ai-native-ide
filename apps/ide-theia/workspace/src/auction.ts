// Sealed-bid ranking: the highest reserved bid wins, and no one can pay after
// seeing the winning bid. Tie-break is still an open divergence (see product-intent).

export interface Bid {
    id: string;
    campaignId: string;
    /** Reserved amount, hidden until the auction closes. */
    sealedAmount: number;
    createdAt: number;
}

export function rank(bids: Bid[]): Bid[] {
    return [...bids].sort((a, b) => {
        if (b.sealedAmount !== a.sealedAmount) {
            return b.sealedAmount - a.sealedAmount;
        }
        // TODO: tie-break must reflect product intent, not creation order.
        return a.createdAt - b.createdAt;
    });
}
