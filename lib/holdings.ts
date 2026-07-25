"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "./networks";
import type { Token } from "./tokens";

// What an address actually holds, discovered rather than declared.
//
// A curated list only ever shows the tokens someone thought to list, which
// leaves a wallet holding tokenized Apple looking empty until its owner goes
// and pastes a contract address. The explorer already indexes every ERC-20 an
// address touches, so the portfolio asks it and shows what is there.
//
// The balances that come back are indexed, so a very recent transfer can lag;
// anything the app reads directly from the chain stays authoritative where the
// two disagree.

export type Holding = {
  token: Token;
  /** Base units, as the explorer reported them. */
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

/** Every ERC-20 `owner` holds on the active network, largest USD value first. */
export async function fetchHoldings(owner: `0x${string}`): Promise<Holding[]> {
  const net = activeNetwork();
  try {
    const res = await fetch(`${net.explorer}/api/v2/addresses/${owner}/token-balances`);
    if (!res.ok) return [];
    const data = (await res.json()) as ApiRow[] | { items?: ApiRow[] };
    const rows = Array.isArray(data) ? data : (data.items ?? []);

    return rows
      .filter((r) => r.token?.type === "ERC-20" && r.token.symbol && (r.token.address_hash ?? r.token.address))
      .map((r) => {
        const decimals = Number(r.token.decimals ?? 18);
        const rate = Number(r.token.exchange_rate);
        return {
          token: {
            symbol: r.token.symbol as string,
            name: r.token.name ?? (r.token.symbol as string),
            address: (r.token.address_hash ?? r.token.address) as `0x${string}`,
            decimals,
            logoURI: r.token.icon_url ?? undefined,
          },
          value: BigInt(r.value ?? "0"),
          rate: isFinite(rate) && rate > 0 ? rate : null,
        };
      })
      .filter((h) => h.value > 0n)
      .sort((a, b) => {
        const av = Number(formatUnits(a.value, a.token.decimals)) * (a.rate ?? 0);
        const bv = Number(formatUnits(b.value, b.token.decimals)) * (b.rate ?? 0);
        return bv - av;
      });
  } catch {
    return [];
  }
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
