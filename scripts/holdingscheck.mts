// Holdings should be discovered, not declared, and every one of them priced.
import { fetchHoldings } from "../lib/holdings";
import { fetchTokenPriceUsd } from "../lib/tokenPrice";
import { formatUnitsExact } from "../lib/prices";

const W = "0x0f02AdCB7d6d8871ad9555A7f0d90F5faE69A7a6" as const;
const holdings = await fetchHoldings(W);
console.log(`discovered ${holdings.length} tokens for ${W}\n`);

let total = 0;
for (const h of holdings) {
  const price = await fetchTokenPriceUsd(h.token, h.rate);
  const amount = Number(formatUnitsExact(h.value, h.token.decimals).replace(/,/g, ""));
  const usd = price === null ? "no price" : `$${(amount * price).toFixed(2)}`;
  if (price !== null) total += amount * price;
  console.log(
    `${h.token.symbol.padEnd(6)} ${formatUnitsExact(h.value, h.token.decimals).padEnd(24)} ${usd.padEnd(12)} ${h.token.name}`,
  );
}
console.log(`\npriced total: $${total.toFixed(2)}`);
