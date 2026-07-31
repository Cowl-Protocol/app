"use client";

import { useCallback, useEffect, useState } from "react";
import { activeNetwork } from "./networks";
import { fetchHoldings } from "./holdings";
import { fetchTokenPriceUsd } from "./tokenPrice";
import { TOKENS, tokenAddressForField, tokenMetaForField, type Token } from "./tokens";
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

/**
 * Tokens to ask the chain about whatever the explorer says.
 *
 * The curated list, plus anything the caller knows is in play. A wallet holding
 * a token the explorer's balance index has not caught up on is not a wallet
 * holding nothing of it, and the portfolio reported exactly that.
 */
function alwaysRead(extra: `0x${string}`[]): `0x${string}`[] {
  const out = new Set<string>();
  for (const t of TOKENS) {
    if (t.native || /^0x0{40}$/i.test(t.address)) continue;
    out.add(t.address.toLowerCase());
  }
  for (const a of extra) out.add(a.toLowerCase());
  return [...out] as `0x${string}`[];
}

export async function fetchAssets(
  owner: `0x${string}` | null,
  /** Extra token addresses to read from the chain — the shielded book's, typically. */
  extra: `0x${string}`[] = [],
): Promise<Asset[]> {
  const native = TOKENS[0]!;
  if (!owner) {
    return [{ token: native, balance: null, price: await fetchTokenPriceUsd(native), status: "unasked" }];
  }

  const [nativeBalance, holdings] = await Promise.all([
    fetchBalance(owner, native).catch(() => null),
    fetchHoldings(owner, alwaysRead(extra)),
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

/**
 * Assets for an address: the native coin, everything it holds, then the curated rest.
 *
 * `refresh` reads again on demand. This side of the book is discovered through
 * the explorer's index, which trails the chain by a little, and the read fires
 * once per address — so a balance that has just moved keeps showing its old
 * number until something asks again. Withdrawing to your own wallet and finding
 * the public card unchanged is exactly that, and reloading the page is not an
 * answer anyone should have to find. The private book already hands the owner
 * that button; this gives the public one the same.
 */
export function useAssets(
  owner: `0x${string}` | null,
  /** Token addresses to read from the chain even if the explorer omits them. */
  extra: `0x${string}`[] = [],
): {
  assets: Asset[];
  loading: boolean;
  refresh: () => void;
} {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped to read the same address again. The previous answer stays on screen
  // while the new one is on its way: a refresh that blanks the balances would
  // look like the wallet emptied.
  const [reads, setReads] = useState(0);
  const extraKey = extra.join(",");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchAssets(owner, extraKey ? (extraKey.split(",") as `0x${string}`[]) : []).then((a) => {
      if (!alive) return;
      setAssets(a);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // Keyed by the joined list rather than the array, or a fresh array on every
    // render would re-read the chain on every render.
  }, [owner, reads, extraKey]);

  return { assets, loading, refresh: useCallback(() => setReads((n) => n + 1), []) };
}

/**
 * The shielded book as the same kind of list the public one is.
 *
 * A private holding is a holding: it deserves the asset's real name, its icon
 * and what it is worth, not a ticker and a raw number. The only thing that
 * differs is where the balance came from, so the rows are built to the same
 * shape and rendered by the same component.
 *
 * `known` is the public book, used purely as a metadata source — a token held
 * on both sides is named once. A token held only privately still resolves,
 * just from the leaner local lists.
 */
export function useShieldedAssets(
  balances: { token: bigint; amount: bigint }[],
  known: Asset[],
): { assets: Asset[]; loading: boolean } {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  // Field ids and amounts, so a re-render with an equal list does no work.
  const signature = balances.map((b) => `${b.token}:${b.amount}`).join(",");
  const knownKey = known.map((a) => a.token.address).join(",");

  useEffect(() => {
    let alive = true;
    if (balances.length === 0) {
      setAssets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      balances.map(async (b) => {
        const address = tokenAddressForField(b.token);
        const meta = tokenMetaForField(b.token);
        const hint =
          known.find((a) => a.token.address.toLowerCase() === address.toLowerCase()) ??
          (b.token === 0n ? known.find((a) => a.token.native) : undefined);
        const token: Token = hint?.token ?? {
          symbol: meta.symbol,
          name: meta.symbol,
          address,
          decimals: meta.decimals,
          ...(b.token === 0n ? { native: true } : {}),
        };
        // The public side already priced this one; asking again would spend a
        // round of quotes to learn the same number.
        const price = hint?.price ?? (await fetchTokenPriceUsd(token));
        return { token, balance: b.amount, price, status: "held" as AssetStatus };
      }),
    ).then((rows) => {
      if (!alive) return;
      setAssets(rows);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, knownKey]);

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
