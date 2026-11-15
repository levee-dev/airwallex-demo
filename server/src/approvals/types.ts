/** A first purchase from a shop: what the agent declared beside what the card network sent. */
export interface FirstPurchaseFacts {
  readonly declared: {
    readonly name: string;
    readonly domain: string;
    readonly amountMinor: number;
    readonly currency: string;
  };
  readonly observed: {
    readonly descriptor: string;
    readonly mcc: string;
    readonly category: string;
    readonly country: string;
  };
}
