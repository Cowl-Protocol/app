"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "./networks";

// USD pricing.
//
// The native coin's price comes from the explorer's own stats endpoint, and
// listed tokens carry theirs in the token list. Nothing is hardcoded: a fixed
// anchor reads as a real valuation while quietly drifting from the market,
// which is how a wallet holding $32 of ETH came to be shown as $52.
//
// A price that cannot be fetched is left absent rather than guessed, and the
// USD line simply does not render. An invented valuation is worse than none.

const TTL = 5 * 60 * 1000;

type Cached = { at: number; price: number };
let memo: Cached | null = null;
let memoKey = "";
let inflight: Promise<number | null> | null = null;

/** USD price of the network's native coin, or null when it isn't available. */
export async function fetchNativePrice(): Promise<number | null> {
  const net = activeNetwork();
  if (memo && memoKey === net.key && Date.now() - memo.at < TTL) return memo.price;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(`${net.explorer}/api/v2/stats`);
      if (!res.ok) return null;
      const data = (await res.json()) as { coin_price?: string | number | null };
      const price = Number(data.coin_price);
      if (!isFinite(price) || price <= 0) return null;
      memo = { at: Date.now(), price };
      memoKey = net.key;
      return price;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The native coin's USD price once it lands; null until then, and if it never does. */
export function useNativePrice(): number | null {
  const [price, setPrice] = useState<number | null>(memo?.price ?? null);
  useEffect(() => {
    let alive = true;
    fetchNativePrice().then((p) => {
      if (alive) setPrice(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  return price;
}

/** A USD amount, or null when the price behind it is unknown. */
export function usdOf(amount: number, price: number | null): string | null {
  if (price === null || !isFinite(amount)) return null;
  return `$${(amount * price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A balance, exactly as the chain reports it.
 *
 * Takes the string formatUnits already produced, so no float and no rounding
 * step ever touches the number: every digit the chain reported survives to the
 * screen. Trailing zeros go, since they carry nothing, and the integer part
 * gets thousands separators for readability. Rounding a balance to a fixed
 * number of places is what turned a small holding into a flat zero and a
 * precise one into an approximation.
 */
export function formatBalance(exact: string): string {
  if (!exact) return "0";
  const negative = exact.startsWith("-");
  const [whole = "0", fraction = ""] = exact.replace("-", "").split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${trimmed ? `.${trimmed}` : ""}`;
}

/** Same, from base units. */
export function formatUnitsExact(value: bigint, decimals: number): string {
  return formatBalance(formatUnits(value, decimals));
}
