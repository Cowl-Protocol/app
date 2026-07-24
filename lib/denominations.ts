// Mirror of the CLI's denomination ladder (cli/src/shielded/denominations.ts).
//
// A boundary amount is calldata: shield 0.2337 and later withdraw 0.2337 and
// the two ends link themselves, however sound the proofs are. Amounts that
// travel in shared denominations don't have that edge — every 0.1 looks like
// every other 0.1, and each tier is an anonymity set that grows with use.
// The ladder is powers of ten around one whole token, it's client-side only,
// and --exact passes the raw amount through in a single transaction.

const TIER_STEPS = [1, 0, -1, -2, -3] as const;

/** Boundary transactions one command may fan out into. Past this the amount
 * wants rounding (or --exact), not a parade of deposits. */
export const MAX_BOUNDARY_TXS = 12;

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
