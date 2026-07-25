"use client";

import { useEffect, useState } from "react";
import { activeNetwork } from "./networks";
import { fetchHoldings } from "./holdings";
import { fetchTokenPriceUsd } from "./tokenPrice";
import { TOKENS, type Token } from "./tokens";
import { fetchBalance } from "./useWallet";

// One answer to "what does this wallet have, and what is it worth", shared by
// every surface that asks.
//
// The portfolio and the token picker were each assembling this themselves and
// drifting apart in the process: the picker fetched a balance per token over
// RPC against a list captured before discovery finished, so a token found a
// moment later showed a blank where its balance should be. Here the balance
// arrives with the holding that revealed it, which is both correct and one
// request instead of one per token.

/**
 * Why a balance is missing, which is three different things a row was
 * flattening into one. "unread" is a read that was made and failed. "unasked"
 * is a token nobody looked up, like a row from the chain's own list. Calling
 * either of those unavailable while the answer is still on its way, as this
 * did, states a fact nobody has checked.
 */
export type AssetStatus = "held" | "unread" | "unasked";

export type Asset = {
  token: Token;
  /** Base units. Null unless the status is "held". */
  balance: bigint | null;
  /** USD per whole token, or null when nothing will price it. */
  price: number | null;
  status: AssetStatus;
};

/** Curated entries the wallet holds nothing of still belong in a picker. */
function curatedPlaceholders(held: Set<string>): Token[] {
  return TOKENS.filter((t) => {
    if (t.native) return false;
    if (/^0x0{40}$/i.test(t.address)) return false;
    return !held.has(t.address.toLowerCase());
  });
}

export async function fetchAssets(owner: `0x${string}` | null): Promise<Asset[]> {
  const native = TOKENS[0]!;
  if (!owner) {
    return [{ token: native, balance: null, price: await fetchTokenPriceUsd(native), status: "unasked" }];
  }

  const [nativeBalance, holdings] = await Promise.all([
    fetchBalance(owner, native).catch(() => null),
    fetchHoldings(owner),
  ]);

  const heldAddresses = new Set(holdings.map((h) => h.token.address.toLowerCase()));
  const rows: { token: Token; balance: bigint | null; rate: number | null }[] = [
    { token: native, balance: nativeBalance, rate: null },
    ...holdings.map((h) => ({ token: h.token, balance: h.value, rate: h.rate })),
    ...curatedPlaceholders(heldAddresses).map((t) => ({ token: t, balance: 0n, rate: null })),
  ];

  return Promise.all(
    rows.map(async (r) => ({
      token: r.token,
      balance: r.balance,
      price: await fetchTokenPriceUsd(r.token, r.rate),
      status: (r.balance === null ? "unread" : "held") as AssetStatus,
    })),
  );
}

/** Assets for an address: the native coin, everything it holds, then the curated rest. */
export function useAssets(owner: `0x${string}` | null): { assets: Asset[]; loading: boolean } {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchAssets(owner).then((a) => {
      if (!alive) return;
      setAssets(a);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [owner]);

  return { assets, loading };
}

/** Total USD across the assets that have a price. */
export function totalUsd(assets: Asset[]): { total: number; priced: boolean } {
  let total = 0;
  let priced = false;
  for (const a of assets) {
    if (a.status !== "held" || a.balance === null || a.price === null) continue;
    priced = true;
    total += Number(a.balance) / 10 ** a.token.decimals * a.price;
  }
  return { total, priced };
}

// Robinhood's tokenized assets all carry the same suffix on chain. Surfaces
// show the asset and mark the class, so the name isn't spent on boilerplate.
const TOKENIZED_MARK = " • Robinhood Token";

export function isTokenized(name: string): boolean {
  return name.endsWith(TOKENIZED_MARK);
}

export function displayName(name: string): string {
  return isTokenized(name) ? name.slice(0, -TOKENIZED_MARK.length) : name;
}

/** The network's own coin, for surfaces that need it by itself. */
export function nativeToken(): Token {
  return TOKENS[0]!;
}

export { activeNetwork };
