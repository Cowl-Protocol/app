// Indicative USD anchors for the testnet venue — real routing quotes land when
// the on-chain quoter is wired to the panels. Shared by the swap card, the
// shield card and the portfolio so every surface prices the same way.
export const USD: Record<string, number> = { ETH: 3000, WETH: 3000, USDG: 1, COWL: 0.5 };

export function usdValue(symbol: string, amount: number): number {
  return (USD[symbol] ?? 0) * amount;
}
