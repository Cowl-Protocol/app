import { fallback, http } from "viem";
import type { NetworkDef } from "./networks";

// Robinhood's own RPC endpoints answer from some regions and not others, so
// every client runs primary-then-explorer. The primary gets a short leash and
// no retries: where it does answer that budget is never spent, and where it
// doesn't the page falls through to the explorer's endpoint in a couple of
// seconds instead of waiting out a ten second default three times over.
export function transportFor(net: NetworkDef) {
  return fallback([
    http(net.rpcUrl, { timeout: 2_500, retryCount: 0 }),
    ...(net.rpcFallback ? [http(net.rpcFallback, { timeout: 15_000, retryCount: 2 })] : []),
  ]);
}
