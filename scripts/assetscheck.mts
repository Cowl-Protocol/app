// One asset list, whatever asks for it. Run: npx tsx scripts/assetscheck.mts
import { fetchAssets, totalUsd, displayName, isTokenized } from "../lib/assets";
import { formatUnitsExact } from "../lib/prices";

const W = "0x0f02AdCB7d6d8871ad9555A7f0d90F5faE69A7a6" as const;
const assets = await fetchAssets(W);

console.log(`${assets.length} assets for ${W}\n`);
for (const a of assets) {
  const bal = a.balance === null ? "unavailable" : formatUnitsExact(a.balance, a.token.decimals);
  const usd =
    a.balance === null || a.price === null
      ? ""
      : `$${((Number(a.balance) / 10 ** a.token.decimals) * a.price).toFixed(2)}`;
  const tag = isTokenized(a.token.name) ? " [RWA]" : "";
  console.log(`${a.token.symbol.padEnd(6)} ${bal.padEnd(24)} ${usd.padEnd(10)} ${displayName(a.token.name)}${tag}`);
}
const { total, priced } = totalUsd(assets);
console.log(`\ntotal: ${priced ? `$${total.toFixed(2)}` : "—"}`);
console.log("every held asset carries a balance:", assets.filter((a) => a.balance !== null).length === assets.length);
