// Relay-check: the browser's relay client against the relayer that is actually
// running. Run with:  npx tsx scripts/relaycheck.mts
//
// The wire format is shared with the CLI and drifting from it is silent: a
// mis-parsed fee would be bound into a proof and the spend would revert with
// nothing on screen explaining why. So the quote is parsed from the live
// daemon, and the guard that refuses a relayer serving the wrong chain or the
// wrong pool is exercised against real answers rather than a fixture.
//
// It sends nothing and signs nothing.
import { fetchQuote, tryQuote } from "../lib/relay";
import { NETWORKS } from "../lib/networks";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const testnet = NETWORKS["robinhood-testnet"]!;
const mainnet = NETWORKS["robinhood-mainnet"]!;

// ---- the live testnet relayer ------------------------------------------------
let quote: Awaited<ReturnType<typeof fetchQuote>> | null = null;
try {
  quote = await fetchQuote(testnet.defaultRelay!);
  check("the live relayer answers a quote", true, `${testnet.defaultRelay}`);
} catch (e) {
  check("the live relayer answers a quote", false, (e as Error).message);
}

if (quote) {
  check("quote names a payout address", /^0x[0-9a-fA-F]{40}$/.test(quote.relayer), quote.relayer);
  check("fee parses as a positive amount", quote.fee > 0n, `${quote.fee} base units`);
  check("quote carries a chain", Number.isInteger(quote.chainId) && quote.chainId > 0, String(quote.chainId));
  check("quote names the pool it serves", /^0x[0-9a-fA-F]{40}$/.test(quote.pool), quote.pool);
  check(
    "it is the pool this network is configured for",
    quote.pool.toLowerCase() === testnet.contracts.pool!.toLowerCase(),
  );
}

// ---- the guard that keeps a wrong relayer out of a proof ---------------------
const matched = await tryQuote(testnet.defaultRelay, testnet.chainId, testnet.contracts.pool!);
check("a matching relayer is accepted", matched !== null);

// The same daemon, asked as if it served mainnet: right URL, wrong chain.
const crossChain = await tryQuote(testnet.defaultRelay, mainnet.chainId, mainnet.contracts.pool!);
check("a relayer on another chain is refused", crossChain === null);

const wrongPool = await tryQuote(
  testnet.defaultRelay,
  testnet.chainId,
  "0x000000000000000000000000000000000000dEaD",
);
check("a relayer serving another pool is refused", wrongPool === null);

const down = await tryQuote("https://relay.invalid.cowlprotocol.com", testnet.chainId, testnet.contracts.pool!);
check("a relayer that is down yields null, not a throw", down === null);

const unset = await tryQuote(undefined, testnet.chainId, testnet.contracts.pool!);
check("no relayer configured yields null", unset === null);

// ---- mainnet, which is where this is headed ----------------------------------
const live = await tryQuote(mainnet.defaultRelay, mainnet.chainId, mainnet.contracts.pool!);
console.log(
  live
    ? `\nmainnet relayer is UP at ${mainnet.defaultRelay} — fee ${live.fee} per spend`
    : `\nmainnet relayer is not serving yet at ${mainnet.defaultRelay}; withdrawals fall back to the wallet`,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
