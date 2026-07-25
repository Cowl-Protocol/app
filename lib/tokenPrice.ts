"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "./networks";
import type { Token } from "./tokens";
import { publicClient } from "./useWallet";

// What a token is worth, asked of the chain.
//
// The venue's quoter is the source: it reads the same pools a trade would
// execute against, so the number moves when the market moves rather than when
// somebody remembers to update a constant. The explorer's rate is the fallback
// for tokens the venue has no pool for, and a token with neither shows no
// price at all — an invented valuation is worse than a blank.
//
// Pools are quoted across every fee tier and the MEDIAN is taken, never the
// first that answers. That is not caution for its own sake: NVDA has a stray
// pool at the 0.01% tier quoting 0.78 USDG against the 206 its real pools
// quote, and a pricing rule that takes whatever answers first would have shown
// that holding at a two-hundred-and-fiftieth of its value.

const FEE_TIERS = [100, 500, 3000, 10000] as const;
const TTL = 60_000;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

type Cached = { at: number; price: number | null };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<number | null>>();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One unit of `tokenIn` in `tokenOut`, across fee tiers, median of what answers. */
async function quoteAcrossTiers(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  decimalsIn: number,
  decimalsOut: number,
): Promise<number | null> {
  const net = activeNetwork();
  const quoter = net.contracts.quoter;
  if (!quoter || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

  const results = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const { result } = await publicClient.simulateContract({
          address: quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn: 10n ** BigInt(decimalsIn),
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const out = Number(formatUnits(result[0], decimalsOut));
        return isFinite(out) && out > 0 ? out : null;
      } catch {
        return null; // no pool at this tier, or it cannot fill a unit
      }
    }),
  );
  return median(results.filter((r): r is number => r !== null));
}

/** The explorer's own rate for a token, for anything the venue cannot price. */
async function explorerRate(address: `0x${string}`): Promise<number | null> {
  const net = activeNetwork();
  try {
    const res = await fetch(`${net.explorer}/api/v2/tokens/${address}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { exchange_rate?: string | null };
    const rate = Number(data.exchange_rate);
    return isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/** The explorer's price for the network's own coin. */
async function explorerCoinPrice(): Promise<number | null> {
  const net = activeNetwork();
  try {
    const res = await fetch(`${net.explorer}/api/v2/stats`);
    if (!res.ok) return null;
    const data = (await res.json()) as { coin_price?: string | null };
    const price = Number(data.coin_price);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function priceOf(token: Token): Promise<number | null> {
  const net = activeNetwork();
  const { weth, usdg } = net.contracts;
  // USDG is the unit everything else is quoted in, so quoting it against
  // itself would be circular; it is a dollar by definition here.
  if (usdg && !token.native && token.address.toLowerCase() === usdg.toLowerCase()) {
    return (await explorerRate(usdg)) ?? 1;
  }

  // The native coin has no pool of its own; its wrapper is the same asset.
  const priced = token.native ? weth : token.address;
  if (usdg && priced) {
    const direct = await quoteAcrossTiers(priced, usdg, token.native ? 18 : token.decimals, 6);
    if (direct !== null) return direct;

    // No dollar pool: route through the wrapper, which does have one.
    if (weth && priced.toLowerCase() !== weth.toLowerCase()) {
      const inWeth = await quoteAcrossTiers(priced, weth, token.decimals, 18);
      const wethUsd = await quoteAcrossTiers(weth, usdg, 18, 6);
      if (inWeth !== null && wethUsd !== null) return inWeth * wethUsd;
    }
  }

  if (token.native) return explorerCoinPrice();
  return explorerRate(token.address);
}

/** USD price of a token, or null when nothing on chain will say. */
export async function fetchTokenPriceUsd(token: Token): Promise<number | null> {
  const key = `${activeNetwork().key}:${token.native ? "native" : token.address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.price;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const price = await priceOf(token);
      cache.set(key, { at: Date.now(), price });
      return price;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/** A token's USD price once it lands; null until then, and if it never does. */
export function useTokenPrice(token: Token | null): number | null {
  const [price, setPrice] = useState<number | null>(null);
  const key = token ? (token.native ? "native" : token.address.toLowerCase()) : null;

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetchTokenPriceUsd(token).then((p) => {
      if (alive) setPrice(p);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return price;
}
