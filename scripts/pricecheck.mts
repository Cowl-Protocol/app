// Prices must come from the chain, for any token, including one pasted a
// minute ago. Run: npx tsx scripts/pricecheck.mts
import { fetchTokenPriceUsd } from "../lib/tokenPrice";
import type { Token } from "../lib/tokens";

const t = (symbol: string, address: string, decimals: number, native = false): Token =>
  ({ symbol, name: symbol, address: address as `0x${string}`, decimals, native });

const PROBES: [Token, string][] = [
  [t("ETH", "0x0000000000000000000000000000000000000000", 18, true), "the native coin"],
  [t("WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", 18), "curated"],
  [t("USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 6), "the dollar unit"],
  [t("TSLA", "0x322f0929c4625ed5bad873c95208d54e1c003b2d", 18), "a tokenized asset, one pool"],
  [t("NVDA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", 18), "has a stray 0.01% pool quoting 0.78"],
  [t("GOOGL", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", 18), "never seen by the app before"],
];

for (const [token, why] of PROBES) {
  const started = Date.now();
  const price = await fetchTokenPriceUsd(token);
  const shown = price === null ? "no price (line hidden)" : `$${price.toFixed(4)}`;
  console.log(`${token.symbol.padEnd(6)} ${shown.padEnd(24)} ${Date.now() - started}ms   ${why}`);
}
