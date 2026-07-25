import { formatUnits } from "viem";

// Indicative USD anchors for the testnet venue — real routing quotes land when
// the on-chain quoter is wired to the panels. Shared by the swap card, the
// shield card and the portfolio so every surface prices the same way.
export const USD: Record<string, number> = { ETH: 3000, WETH: 3000, USDG: 1, COWL: 0.5 };

export function usdValue(symbol: string, amount: number): number {
  return (USD[symbol] ?? 0) * amount;
}

/**
 * A balance, exactly as the chain reports it.
 *
 * Takes the string formatUnits already produced, so no float and no rounding
 * step ever touches the number: every digit the chain reported survives to the
 * screen. Trailing zeros go, since they carry nothing, and the integer part
 * gets thousands separators for readability. Rounding a balance to a fixed
 * number of places is what turned a small holding into a flat zero and a
 * precise one into an approximation.
 */
export function formatBalance(exact: string): string {
  if (!exact) return "0";
  const negative = exact.startsWith("-");
  const [whole = "0", fraction = ""] = exact.replace("-", "").split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${trimmed ? `.${trimmed}` : ""}`;
}

/** Same, from base units. */
export function formatUnitsExact(value: bigint, decimals: number): string {
  return formatBalance(formatUnits(value, decimals));
}
