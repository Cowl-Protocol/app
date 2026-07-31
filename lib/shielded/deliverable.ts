// What a withdrawal can actually draw, apart from React.
//
// A join-split reads two notes and writes two. That one sentence is the whole
// subject: a book spread across three or more notes holds more than any single
// spend can move, and every screen that offers an amount has to know it. Send
// and swap have; the way out did not, so its MAX button wrote the whole balance
// and the run died at planning on "no two notes cover it" — a wall someone hit
// by pressing the button the card had just offered them.
//
// This lives out here so the check beside it drives the code the screen runs,
// and can hold its answers against the real note selector rather than against a
// second opinion about what the selector does.

/** Why a withdrawal cannot go ahead as typed, or `ok` if it can. */
export type WithdrawVerdict =
  /** Nothing in the way. */
  | "ok"
  /** More than the book holds at all, fee included. */
  | "insufficient"
  /** Held, but the fees to gather it into two notes eat the difference. */
  | "over-reach"
  /** Deliverable, but not in one spend. Merging is the step, not a refusal. */
  | "merge-first";

/**
 * The largest withdrawal a book can deliver, merge rounds included.
 *
 * Not the balance less one fee. Gathering a fragmented book down into two notes
 * costs a relayed fee per round, and those fees come out of the same notes, so
 * n notes cost n − 1 rounds before the amount can leave. Subtracting a single
 * fee writes a number no amount of merging ever reaches: the run pays for every
 * round and still comes up short.
 *
 * Self-paid rounds cost the wallet rather than the notes, so with no fee this
 * collapses back to the balance — which is right, and is the case that lets a
 * book smaller than one fee come back out at all.
 */
export function maxDeliverable(balance: bigint, noteCount: number, feePerPart: bigint): bigint {
  if (feePerPart <= 0n) return balance;
  const feesToEmpty = BigInt(Math.max(noteCount - 1, 1)) * feePerPart;
  return balance > feesToEmpty ? balance - feesToEmpty : 0n;
}

/**
 * What stands between this withdrawal and the chain.
 *
 * `parts` is every spend the withdrawal will make — one in Exact, several
 * across the denomination tiers in Shared. Each is its own join-split, so the
 * ceiling applies to the biggest of them rather than to their sum, and each
 * pays its own fee.
 *
 * The order the answers are tried in is the order someone can act on them: a
 * balance they do not have outranks a shape they could merge out of.
 */
export function withdrawVerdict(args: {
  /** Everything the book holds in this token. */
  balance: bigint;
  /** The two largest notes, which is all one spend reaches. */
  sendable: bigint;
  /** How many unspent notes the book holds in this token. */
  noteCount: number;
  /** Every spend this withdrawal makes. */
  parts: bigint[];
  /** What each of those spends pays a relayer, or 0 when the wallet pays. */
  feePerPart: bigint;
}): WithdrawVerdict {
  const { balance, sendable, noteCount, parts, feePerPart } = args;
  if (parts.length === 0) return "ok";

  const drawn = parts.reduce((s, p) => s + p, 0n) + feePerPart * BigInt(parts.length);
  if (drawn > balance) return "insufficient";
  if (drawn > maxDeliverable(balance, noteCount, feePerPart)) return "over-reach";

  const largest = parts.reduce((m, p) => (p > m ? p : m), 0n);
  if (largest + feePerPart > sendable) return "merge-first";
  return "ok";
}
