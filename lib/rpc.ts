// The read-only chain client, with no React attached.
//
// Split out of useWallet so that modules which only ever read the chain can be used
// outside a browser. `lib/earn.ts` is the reason: its logic decides what a claim pays,
// so it needs to be runnable in a plain Node harness against a real network, and it
// could not be while importing a "use client" module full of hooks.
//
// Nothing here depends on a wallet being connected. A wallet is needed to sign, never
// to look.
import { createPublicClient } from "viem";

import { activeNetwork, toViemChain } from "./networks";
import { transportFor } from "./transport";

const net = activeNetwork();

/** Read-only client used for balances and views, independent of any wallet. */
export const publicClient = createPublicClient({
  chain: toViemChain(net),
  transport: transportFor(net),
  // Concurrent contract reads collapse into a single multicall, so a page of balances
  // costs one request rather than one per token.
  batch: { multicall: { wait: 24 } },
});
