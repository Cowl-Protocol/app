"use client";

import { useEffect, useState } from "react";
import { formatUnits, erc20Abi, type Address } from "viem";
import { activeNetwork } from "./networks";
import { publicClient } from "./rpc";
import type { Token } from "./tokens";

// What an address actually holds, discovered rather than declared.
//
// A curated list only ever shows the tokens someone thought to list, which
// leaves a wallet holding tokenized Apple looking empty until its owner goes
// and pastes a contract address. The explorer already indexes every ERC-20 an
// address touches, so the portfolio asks it and shows what is there.
//
// The explorer is the only way to *discover* an arbitrary token, and it is not
// allowed to be the authority on what is in the wallet. That sentence used to
// live here as an intention — "anything the app reads directly from the chain
// stays authoritative where the two disagree" — while nothing read the chain at
// all, and the gap it left was not theoretical: an unshielded AAPL balance sat
// in a wallet the chain agreed held it, and the portfolio said the wallet held
// $13.87 when it held nearer $37. The explorer had indexed the transfer and
// still did not list the balance.
//
// So discovery and truth are now separate jobs. The explorer answers "which
// tokens has this address ever touched"; every number on screen comes from
// `balanceOf`, batched into one multicall. A balance that reads low is the one
// failure a wallet must never quietly commit.

export type Holding = {
  token: Token;
  /** Base units, read from the chain. The explorer never sets this. */
  value: bigint;
  /** The explorer's own USD rate, when it has one — a fallback for pricing. */
  rate: number | null;
};

type ApiToken = {
  address_hash?: string;
  address?: string;
  decimals: string | null;
  symbol: string | null;
  name: string | null;
  icon_url: string | null;
  exchange_rate: string | null;
  type: string;
};

type ApiRow = { token: ApiToken; value: string };

type Found = Map<string, { meta: Partial<Token>; rate: number | null }>;

function note(found: Found, t: ApiToken | undefined): void {
  const address = (t?.address_hash ?? t?.address) as `0x${string}` | undefined;
  if (!address || t?.type !== "ERC-20" || found.has(address.toLowerCase())) return;
  const rate = Number(t.exchange_rate);
  found.set(address.toLowerCase(), {
    meta: {
      address,
      symbol: t.symbol ?? undefined,
      name: t.name ?? t.symbol ?? undefined,
      decimals: t.decimals === null ? undefined : Number(t.decimals),
      logoURI: t.icon_url ?? undefined,
    },
    rate: isFinite(rate) && rate > 0 ? rate : null,
  });
}

async function rows<T>(url: string, pick: (r: T) => ApiToken | undefined, found: Found): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const data = (await res.json()) as T[] | { items?: T[] };
    for (const r of Array.isArray(data) ? data : (data.items ?? [])) note(found, pick(r));
  } catch {
    /* every source here is optional; the chain is what decides the numbers */
  }
}

/**
 * Which tokens to ask the chain about. Discovery only — no balances.
 *
 * Two sources, because one of them was wrong in the case that prompted this.
 * `token-balances` is the obvious endpoint and the explorer had simply not
 * recomputed it for the holder. `token-transfers` had the same transfer
 * indexed, minutes after it landed. A wallet that received a token has a
 * transfer for it by definition, which makes the second source strictly the
 * better question to be asking — and asking both costs one extra request.
 */
async function discover(owner: Address): Promise<Found> {
  const net = activeNetwork();
  const found: Found = new Map();
  await Promise.all([
    rows<ApiRow>(`${net.explorer}/api/v2/addresses/${owner}/token-balances`, (r) => r.token, found),
    rows<{ token?: ApiToken }>(
      `${net.explorer}/api/v2/addresses/${owner}/token-transfers?type=ERC-20`,
      (r) => r.token,
      found,
    ),
  ]);
  return found;
}

/**
 * Every ERC-20 `owner` holds, largest USD value first.
 *
 * `alsoRead` is asked about whatever the explorer says. Pass the tokens the app
 * already knows are in play — the curated list, and the ones in this wallet's
 * shielded book — and a token the explorer has not caught up on still appears.
 * That last case is the one that made this necessary: the private side of the
 * screen knew about the AAPL the public side could not see, from its own notes.
 */
export async function fetchHoldings(owner: `0x${string}`, alsoRead: Address[] = []): Promise<Holding[]> {
  const discovered = await discover(owner);
  for (const a of alsoRead) {
    if (!discovered.has(a.toLowerCase())) discovered.set(a.toLowerCase(), { meta: { address: a }, rate: null });
  }
  if (discovered.size === 0) return [];

  const entries = [...discovered.entries()];
  const client = publicClient;

  // One multicall for the lot. The balance is read for every candidate; symbol
  // and decimals only for the ones the explorer could not name.
  const balances = await Promise.all(
    entries.map(([address]) =>
      client
        .readContract({ address: address as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
        .catch(() => null),
    ),
  );

  const holdings: Holding[] = [];
  await Promise.all(
    entries.map(async ([address, { meta, rate }], i) => {
      const value = balances[i];
      // A read that failed is not a balance of zero, and neither is dropped
      // silently: it is simply not claimed as a holding.
      if (value === null || value === undefined || value <= 0n) return;
      let { symbol, decimals, name, logoURI } = meta;
      if (symbol === undefined || decimals === undefined) {
        const [s, d] = await Promise.all([
          client.readContract({ address: address as Address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
          client.readContract({ address: address as Address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
        ]);
        symbol = symbol ?? s ?? `${address.slice(0, 6)}…`;
        decimals = decimals ?? d ?? 18;
      }
      holdings.push({
        token: {
          symbol: symbol as string,
          name: name ?? (symbol as string),
          address: address as `0x${string}`,
          decimals: decimals as number,
          logoURI,
        },
        value,
        rate,
      });
    }),
  );

  return holdings.sort((a, b) => {
    const av = Number(formatUnits(a.value, a.token.decimals)) * (a.rate ?? 0);
    const bv = Number(formatUnits(b.value, b.token.decimals)) * (b.rate ?? 0);
    return bv - av;
  });
}

/** Holdings for the connected address; empty while loading or when none. */
export function useHoldings(owner: `0x${string}` | null): { holdings: Holding[]; loading: boolean } {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!owner) {
      setHoldings([]);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchHoldings(owner).then((h) => {
      if (!alive) return;
      setHoldings(h);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [owner]);

  return { holdings, loading };
}
