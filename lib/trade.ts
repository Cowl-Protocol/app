"use client";

// The card half of the private trade: which pairs route, and what the venue
// charges for an exact output right now.
//
// A trade is exact-output — the amount typed is what arrives, and the quoter
// answers what the router will draw for it. The number here is a display of
// the venue's price, not the one the run binds: tradeExec re-quotes seconds
// before proving, because the spend's value is the swap's hard input cap and a
// quote gone stale by minutes is the difference between a trade and a revert.
import { useEffect, useState } from "react";
import { activeNetwork } from "./networks";
import { quoteBestExactInput, quoteBestExactOutput, venueLeg } from "./shielded/contract";

const net = activeNetwork();

/**
 * The input side of a trade: native, unless the output is native — then USDG.
 *
 * Same rule as the CLI. Every route is one hop at the configured fee tier, so
 * one side of every pair is the leg the venue's liquidity actually stands in:
 * WETH for a token purchase, the dollar for a sale back to ETH.
 */
export function tradeInputFor(tokenOutField: bigint): bigint {
  if (tokenOutField !== 0n) return 0n;
  const usdg = net.contracts.usdg;
  if (!usdg) throw new Error(`No USDG configured on ${net.label}.`);
  return BigInt(usdg);
}

/** Which side the typed number anchors: the exact output, or the input. */
export type TradeAnchor = "receive" | "pay";

export type TradeQuote =
  | { state: "idle" }
  | { state: "checking" }
  /** `value` is the OTHER side of the typed amount; `feeTier` is the pool that priced it. */
  | { state: "priced"; value: bigint; feeTier: number }
  /** No pool at any tier prices this pair. */
  | { state: "unpriceable" };

/** How often a standing quote is re-read while the card is open. */
const REFRESH_MS = 20_000;

/**
 * The venue's current price for the typed side, kept fresh while the card is
 * open. Anchored on receive it answers what the exact output costs; anchored
 * on pay it answers what that input buys — both scanned across every fee tier,
 * because pairs live where their liquidity is. "Unpriceable" is a real answer,
 * not a failure: it is how the card says the venue has no pool for this pair
 * rather than showing a zero.
 */
export function useTradeQuote(
  tokenInField: bigint,
  tokenOutField: bigint,
  amount: bigint,
  anchor: TradeAnchor,
): TradeQuote {
  const [quote, setQuote] = useState<TradeQuote>({ state: "idle" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (amount <= 0n || tokenInField === tokenOutField || !net.contracts.quoter) {
      setQuote({ state: "idle" });
      return;
    }
    let alive = true;
    // Only the first read of a new question shows as checking; the periodic
    // refresh replaces the number quietly instead of blinking the row.
    setQuote((q) => (q.state === "priced" ? q : { state: "checking" }));
    const inLeg = venueLeg(net, tokenInField);
    const outLeg = venueLeg(net, tokenOutField);
    const ask =
      anchor === "receive"
        ? quoteBestExactOutput(net, inLeg, outLeg, amount)
        : quoteBestExactInput(net, inLeg, outLeg, amount);
    ask
      .then((best) => {
        if (alive) setQuote({ state: "priced", value: best.amount, feeTier: best.feeTier });
      })
      .catch(() => {
        if (alive) setQuote({ state: "unpriceable" });
      });
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenInField, tokenOutField, amount, anchor, tick]);

  return quote;
}
