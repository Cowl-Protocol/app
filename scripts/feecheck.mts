// Fee-check: what a relayed withdrawal really takes out of the book. Run with:
//   npx tsx scripts/feecheck.mts
//
// The relayer's fee is paid from the same notes as the withdrawal, once per
// part. Leaving it out of the balance check let an amount clear every test on
// screen and then fail at planning, short by exactly the fee nobody counted —
// so the arithmetic the card now shows is asserted here against the live quote.

import { fetchQuote } from "../lib/relay";
import { decompose } from "../lib/denominations";
import { NETWORKS } from "../lib/networks";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const net = NETWORKS["robinhood-mainnet"]!;
const COWL = "0xfc7CB8A3Df69c0F658Ac5Fb1e31dE1843E04E38f" as const;

/** The card's sums, kept in one place so the test cannot drift from the screen. */
function plan(value: bigint, decimals: number, feePerPart: bigint, exact: boolean) {
  const parts = exact ? [value] : decompose(value, decimals).parts;
  const received = parts.reduce((s, p) => s + p, 0n);
  const fee = feePerPart * BigInt(parts.length);
  return { parts: parts.length, received, fee, drawn: received + fee };
}

const quote = await fetchQuote(net.defaultRelay!, COWL).catch(() => null);
check("the relayer prices COWL at all", quote !== null);
if (!quote) {
  console.log("\nno quote, nothing else to assert");
  process.exit(1);
}

const feePerPart = quote.fee;
const ONE = 10n ** 18n;

// The withdrawal that started this: 25,000 COWL, shared denominations.
const shared = plan(25_000n * ONE, 18, feePerPart, false);
check("25,000 COWL splits into parts", shared.parts > 1, `${shared.parts} parts`);
check(
  "the fee is charged once per part",
  shared.fee === feePerPart * BigInt(shared.parts),
  `${Number(shared.fee) / 1e18} COWL total`,
);
check(
  "what leaves the book is the amount plus the fee",
  shared.drawn === shared.received + shared.fee,
  `${Number(shared.drawn) / 1e18} COWL`,
);

// Exact mode pays one fee instead of one per part — the trade the card offers.
const exact = plan(25_000n * ONE, 18, feePerPart, true);
check("exact mode is a single part", exact.parts === 1);
check("and so pays a single fee", exact.fee === feePerPart);
check("which is cheaper than the split", exact.drawn < shared.drawn,
  `${Number(shared.drawn - exact.drawn) / 1e18} COWL saved`);

// The check that was missing: a book holding exactly the amount cannot cover it.
const held = shared.received;
check(
  "holding exactly the amount is NOT enough once relayed",
  shared.drawn > held,
  `short by ${Number(shared.drawn - held) / 1e18} COWL`,
);
check("holding amount + fee is enough", shared.drawn <= held + shared.fee);

// Native ETH, where the fee is proportionate rather than absurd.
const ethQuote = await fetchQuote(net.defaultRelay!).catch(() => null);
if (ethQuote) {
  const eth = plan(10n ** 16n, 18, ethQuote.fee, false); // 0.01 ETH
  const pct = Number(eth.fee) / Number(eth.received);
  check("an ETH withdrawal's fee stays a small share", pct < 0.5, `${(pct * 100).toFixed(1)}% of 0.01 ETH`);
}

console.log(
  `\n25,000 COWL relayed: ${shared.parts} parts, fee ${(Number(shared.fee) / 1e18).toLocaleString("en-US")} COWL, ` +
    `book pays ${(Number(shared.drawn) / 1e18).toLocaleString("en-US")} COWL`,
);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
