import { fallback, http } from "viem";
import type { NetworkDef } from "./networks";

// One transport per network, built from its ordered endpoint list.
//
// Two shapes of endpoint sit in that list and they want opposite settings. The
// fast ones answer in a few hundred milliseconds and decline the calls they do
// not serve, so a short leash moves past them quickly. The explorer endpoint is
// the only one that serves a historical log replay, but it rate-limits hard, so
// it gets a long timeout and patient spaced retries rather than being raced.
//
// Endpoints are recognised by hostname rather than position: the ordering in
// networks.ts is about preference, and these settings are about behaviour.
function isExplorerEndpoint(url: string): boolean {
  return /blockscout|explorer/i.test(url);
}

/**
 * A provider saying "that block range is too wide" is not a provider failing.
 * Falling through to the next endpoint on it would be wrong twice over: the
 * next one is no likelier to serve the range, and by the time the last one has
 * also declined, the message the caller sees belongs to whichever endpoint
 * happened to be last — so the log reader can no longer tell a cap from an
 * outage, and never splits the range it was being told to split.
 */
function isRangeCap(message: string): boolean {
  // "more than N results" is the same refusal in a shape none of the words
  // below catch — a pre-existing gap, found by the check beside this file when
  // it was written to pin the rate-limit distinction rather than this.
  return /limit|range|exceed|too (?:many|large|broad)|more than \d+ results/i.test(message);
}

/**
 * A rate limit is the endpoint's state, not the request's shape.
 *
 * This has to be asked before `isRangeCap`, and the reason is a collision that
 * cost real waiting: the explorer refuses with **"Too many requests"**, and
 * `too (?:many|…)` reads that as a range cap. So a throttled endpoint was
 * classified as "your request is malformed, nobody else will serve it either",
 * the fallback stopped there, and the one endpoint that answers this chain's
 * historical logs in under half a second was never asked.
 *
 * The distinction is the whole point of surfacing early. A range cap is about
 * the request, so the next endpoint answers the same way and trying it is
 * waste. A rate limit is about *this* endpoint, so the next one answers
 * differently — which is exactly when falling through is the right move.
 */
function isRateLimit(message: string): boolean {
  return /\b429\b|too many requests|rate limit|rate-limit|quota exceeded/i.test(message);
}

/**
 * A revert is the chain's answer, not an endpoint's failure.
 *
 * Asking a second node produces the same revert, so trying the rest of the
 * list only spends their timeouts and retries — which is what turned a token
 * price into a minute of waiting, since pricing quotes every fee tier and most
 * tiers have no pool to quote against.
 */
function isChainAnswer(message: string): boolean {
  return /execution reverted|reverted with|invalid opcode|out of gas|EstimateGas/i.test(message);
}

/**
 * Exported so `scripts/transportcheck.mts` drives this function rather than a
 * second copy of it. A copy is what the two patterns below already were to each
 * other, and reconciling copies is the bug this file just had.
 */
export function surfaceImmediately(error: Error): boolean {
  // First, and the order is load-bearing: a rate limit contains the words a
  // range cap is recognised by, and it means the opposite thing.
  if (isRateLimit(error.message)) return false;
  return isRangeCap(error.message) || isChainAnswer(error.message);
}

export function transportFor(net: NetworkDef) {
  const urls = net.rpcUrls;
  return fallback(
    urls.map((url, i) => {
      // Patience is for a last resort. The explorer's spaced retries were
      // written when it was the only source of a historical log replay, and
      // waiting three spaced rounds on it is right when there is nothing after
      // it. With another endpoint still to try, those rounds are ten seconds
      // spent on a node that has already said no — per request, on a replay
      // that makes many. Fall through instead and let the next one answer.
      const lastResort = i === urls.length - 1;
      if (isExplorerEndpoint(url)) {
        return http(url, {
          timeout: lastResort ? 30_000 : 8_000,
          retryCount: lastResort ? 3 : 0,
          retryDelay: 3_000,
        });
      }
      return http(url, { timeout: 8_000, retryCount: 1 });
    }),
    { shouldThrow: surfaceImmediately },
  );
}
