// Indicative USD anchors for the testnet venue — real routing quotes land when
// the on-chain quoter is wired to the panels. Shared by the swap card, the
// shield card and the portfolio so every surface prices the same way.
export const USD: Record<string, number> = { ETH: 3000, WETH: 3000, USDG: 1, COWL: 0.5 };

export function usdValue(symbol: string, amount: number): number {
  return (USD[symbol] ?? 0) * amount;
}

/**
 * A balance, rendered without lying about it. Four decimal places is right for
 * an ordinary holding and wrong for a small one: a testnet balance of 1.4e-8
 * formats to "0", which reads as an empty wallet rather than a small one. The
 * precision follows the magnitude, so a nonzero balance always shows as nonzero.
 */
export function formatBalance(v: number): string {
  if (!isFinite(v) || v === 0) return "0";
  const decimals = v >= 1 ? 4 : v >= 0.0001 ? 6 : 12;
  return v.toLocaleString("en-US", { maximumFractionDigits: decimals });
}
