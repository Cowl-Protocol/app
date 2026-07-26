// Mirror of the CLI's denomination ladder (cli/src/shielded/denominations.ts).
//
// A boundary amount is calldata: shield 0.2337 and later withdraw 0.2337 and
// the two ends link themselves, however sound the proofs are. Amounts that
// travel in shared denominations don't have that edge — every 0.1 looks like
// every other 0.1, and each tier is an anonymity set that grows with use.
// The ladder is powers of ten around one whole token, it's client-side only,
// and --exact passes the raw amount through in a single transaction.
//
// It reaches six orders of magnitude above one whole token because "one whole
// token" means wildly different things: a sensible amount of ETH is single
// digits, a sensible amount of a million-supply token is millions. Stopping at
// ten tokens meant 3,100,000 COWL decomposed into three hundred and ten
// thousand deposits — past every limit, and no rounding could rescue it. Since
// the split is greedy from the top, the added tiers are invisible to amounts
// that never reach them: an ETH deposit lands on exactly the tiers it always did.
const TIER_STEPS = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3] as const;

/** Boundary transactions one command may fan out into. Past this the amount
 * wants rounding (or --exact), not a parade of deposits. */
export const MAX_BOUNDARY_TXS = 12;

/**
 * The most that can cross in shared denominations at all: the top tier, as many
 * times as the limit allows.
 *
 * Above this no amount fits, however round — every deposit is at most one top
 * tier. Saying "round the amount" there, which the button used to do at every
 * size, sends someone off to try what cannot work; the number itself is the
 * only useful thing to tell them.
 */
export function sharedCeiling(decimals: number): bigint {
  const top = tiersFor(decimals)[0] ?? 0n;
  return top * BigInt(MAX_BOUNDARY_TXS);
}

/** The denomination ladder for a token, largest first, in base units. */
export function tiersFor(decimals: number): bigint[] {
  return TIER_STEPS.map((step) => decimals + step)
    .filter((exp) => exp >= 0)
    .map((exp) => 10n ** BigInt(exp));
}

export type Decomposition = {
  /** Tier-sized amounts, largest first — one boundary transaction each. */
  parts: bigint[];
  /** What's left below the smallest tier. Stays on the side it already sits on. */
  remainder: bigint;
};

/** Greedy largest-first split of `value` into denomination parts. */
export function decompose(value: bigint, decimals: number): Decomposition {
  const parts: bigint[] = [];
  let left = value;
  for (const tier of tiersFor(decimals)) {
    while (left >= tier) {
      parts.push(tier);
      left -= tier;
    }
  }
  return { parts, remainder: left };
}

/** Collapse parts into (tier, count) rows for display, largest first. */
export function groupParts(parts: bigint[]): { tier: bigint; count: number }[] {
  const rows: { tier: bigint; count: number }[] = [];
  for (const part of parts) {
    const last = rows[rows.length - 1];
    if (last && last.tier === part) last.count += 1;
    else rows.push({ tier: part, count: 1 });
  }
  return rows;
}
