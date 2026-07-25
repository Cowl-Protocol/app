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
 * happened to be last — so the log reader can no longer tell a range cap from
 * an outage, and never splits the range it was being told to split. Surfacing
 * it immediately keeps the cap legible to fetchPoolEvents, which then refetches
 * in windows against this same transport.
 */
function isRangeCap(error: Error): boolean {
  return /limit|range|exceed|too (?:many|large|broad)/i.test(error.message);
}

export function transportFor(net: NetworkDef) {
  return fallback(
    net.rpcUrls.map((url) =>
      isExplorerEndpoint(url)
        ? http(url, { timeout: 30_000, retryCount: 3, retryDelay: 3_000 })
        : http(url, { timeout: 8_000, retryCount: 1 }),
    ),
    { shouldThrow: isRangeCap },
  );
}
