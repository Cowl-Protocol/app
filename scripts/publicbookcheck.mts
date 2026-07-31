// Public-book-check: the wallet card never reports less than the wallet holds.
//   npx tsx scripts/publicbookcheck.mts
//
// The bug this guards against showed someone $13.87 of a wallet holding nearer
// $37. They had just unshielded AAPL; the chain agreed the wallet held it; the
// card listed ETH, COWL, WETH and USDG and no AAPL at all. Nothing was lost and
// nothing said anything was missing — the number was simply low.
//
// The cause was the public book taking its balances from the explorer's index
// instead of from the chain. That index had the transfer and had not
// recomputed the balance, so a token the wallet demonstrably held was reported
// as not held. The file's own comment already promised the opposite: "anything
// the app reads directly from the chain stays authoritative where the two
// disagree" — while nothing read the chain.
//
// So the property is one-directional and blunt: for every token the chain says
// the wallet holds, the public book must list it, with the chain's number. An
// explorer that omits it, contradicts it, or fails outright changes nothing.
//
// The stub sits at `fetch`, which is where both the explorer and the RPC leave
// this process, so everything above it — discovery, the multicall batching,
// decimals lookup, sorting — is the code that ships.
import { decodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi, type Hex } from "viem";

import { fetchHoldings } from "../lib/holdings";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const WALLET = "0x3D172B7D7B6afFb50c9E396A3E3206Be7f9E54D9" as const;
// The two from the report, to the wei.
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as const;
const COWL = "0xfc7CB8A3Df69c0F658Ac5Fb1e31dE1843E04E38f" as const;
const CHAIN: Record<string, { symbol: string; decimals: number; balance: bigint }> = {
  [AAPL.toLowerCase()]: { symbol: "AAPL", decimals: 18, balance: 82_711_507_193_351_269n },
  [COWL.toLowerCase()]: { symbol: "COWL", decimals: 18, balance: 621_100n * 10n ** 18n },
};

/** A contract whose reads revert, so a failed read can be told from a zero. */
const BROKEN = "0x2222222222222222222222222222222222222222" as const;

/** Answer one ERC-20 read the way the chain would. */
function answer(to: string, data: Hex): Hex | null {
  if (to.toLowerCase() === BROKEN.toLowerCase()) return null;
  const held = CHAIN[to.toLowerCase()];
  const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
  if (functionName === "balanceOf") {
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: held?.balance ?? 0n });
  }
  if (functionName === "symbol") {
    if (!held) return null;
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: held.symbol });
  }
  if (functionName === "decimals") {
    if (!held) return null;
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: held.decimals });
  }
  return null;
}

/**
 * Stand in for the network. `explorer` decides what the index claims; the chain
 * half always tells the truth, because that is the thing under test.
 */
function stubFetch(explorer: { balances: string[]; transfers: string[]; fail?: boolean }) {
  const calls = { balances: 0, transfers: 0, rpc: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/v2/addresses/")) {
      const which = url.includes("token-transfers") ? "transfers" : "balances";
      calls[which]++;
      if (explorer.fail) return new Response("rate limited", { status: 429 });
      const list = explorer[which];
      const items = list.map((a) => ({
        token: {
          address_hash: a,
          type: "ERC-20",
          // Deliberately no symbol or decimals on the transfers rows, so the
          // on-chain metadata fallback is exercised rather than assumed.
          symbol: which === "balances" ? CHAIN[a.toLowerCase()]?.symbol : null,
          decimals: which === "balances" ? String(CHAIN[a.toLowerCase()]?.decimals ?? 18) : null,
          name: null,
          icon_url: null,
          exchange_rate: null,
        },
        value: "0",
      }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }

    // Everything else is the JSON-RPC endpoint.
    calls.rpc++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params?: unknown[] };
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    if (body.method === "eth_chainId") return reply("0x1237");
    if (body.method !== "eth_call") return reply("0x");

    const p = (body.params?.[0] ?? {}) as { to: string; data: Hex };
    // Multicall3 wraps the reads, which is the path the app really takes.
    if (p.data.startsWith("0x82ad56cb")) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: p.data });
      const inner = args?.[0] as readonly { target: string; allowFailure: boolean; callData: Hex }[];
      const results = inner.map((c) => {
        const out = answer(c.target, c.callData);
        return { success: out !== null, returnData: (out ?? "0x") as Hex };
      });
      return reply(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }));
    }
    const out = answer(p.to, p.data);
    if (out === null) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "reverted" } }), { status: 200 });
    return reply(out);
  }) as typeof fetch;
  return calls;
}

const symbols = (h: { token: { symbol: string } }[]) => h.map((x) => x.token.symbol).sort().join(",");
const valueOf = (h: { token: { symbol: string }; value: bigint }[], s: string) =>
  h.find((x) => x.token.symbol === s)?.value ?? null;

// --- 1. the report, reproduced: the index omits the balance -----------------
{
  // Exactly what the explorer returned that day: COWL in balances, AAPL only
  // in transfers.
  stubFetch({ balances: [COWL], transfers: [AAPL, COWL] });
  const h = await fetchHoldings(WALLET);
  check("a token the balance index omits is still listed", symbols(h) === "AAPL,COWL", symbols(h));
  check(
    "...with the chain's number, not the index's",
    valueOf(h, "AAPL") === CHAIN[AAPL.toLowerCase()]!.balance,
    String(valueOf(h, "AAPL")),
  );
  check(
    "...and its decimals were read from the chain when the index gave none",
    h.find((x) => x.token.symbol === "AAPL")?.token.decimals === 18,
  );
}

// --- 2. the explorer knows nothing at all ------------------------------------
// A caller that already knows a token is in play — the shielded book does — must
// be enough on its own.
{
  stubFetch({ balances: [], transfers: [] });
  const h = await fetchHoldings(WALLET, [AAPL]);
  check("a caller-supplied token is read even with no index at all", symbols(h) === "AAPL");
  check("...at the chain's number", valueOf(h, "AAPL") === CHAIN[AAPL.toLowerCase()]!.balance);
}

// --- 3. the explorer is down -------------------------------------------------
// The failure that used to return an empty list and call it an answer.
{
  const calls = stubFetch({ balances: [COWL], transfers: [AAPL], fail: true });
  const h = await fetchHoldings(WALLET, [AAPL, COWL]);
  check("a rate-limited explorer does not empty the wallet", symbols(h) === "AAPL,COWL", symbols(h));
  check("...and both endpoints were asked", calls.balances === 1 && calls.transfers === 1);
}

// --- 4. the index contradicts the chain --------------------------------------
// The index reports every row with value "0"; the chain says otherwise. The
// chain wins, always, and that is the whole design.
{
  stubFetch({ balances: [AAPL, COWL], transfers: [] });
  const h = await fetchHoldings(WALLET);
  check(
    "an index claiming zero does not zero a balance the chain reports",
    valueOf(h, "AAPL") === CHAIN[AAPL.toLowerCase()]!.balance &&
      valueOf(h, "COWL") === CHAIN[COWL.toLowerCase()]!.balance,
  );
}

// --- 5. a read that failed is not a holding ----------------------------------
// The other way to report wrongly. A balanceOf that reverts says nothing about
// what the wallet has, and a row built on it would put a number on screen that
// nobody read. Listing it is worse than omitting it, because the omission at
// least matches what we know.
{
  stubFetch({ balances: [BROKEN], transfers: [BROKEN] });
  const h = await fetchHoldings(WALLET, [BROKEN]);
  check("a token whose balance could not be read is not listed", h.length === 0, symbols(h));
}

// --- 6. nothing is invented --------------------------------------------------
// The one-directional property has a second half: a token the chain says is not
// held must not appear, however loudly the index lists it.
{
  const GHOST = "0x1111111111111111111111111111111111111111" as const;
  stubFetch({ balances: [GHOST], transfers: [GHOST] });
  const h = await fetchHoldings(WALLET, [GHOST]);
  check("a token the chain says is not held is not listed", h.length === 0, symbols(h));
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
