/**
 * Beta ceilings.
 *
 * One file so the numbers are easy to find, easy to raise, and easy to delete
 * when they stop earning their place.
 */

/**
 * The most a single deposit or private send may be worth, in US dollars.
 *
 * This is a guardrail, not a control. The pool is immutable and enforces no
 * limit of its own, so anything talking to the contract directly walks straight
 * past this. What it does is shape the two clients almost everyone actually
 * uses, and put the number in front of someone before they commit to it.
 *
 * It covers the two paths that build a fresh proof over someone's own funds:
 * shielding, and sending inside the pool. It deliberately does not cover
 * withdrawals. Capping the way out would strand anyone holding more than the
 * cap, and a limit that traps funds is the opposite of a safety measure.
 *
 * Receiving needs no ceiling of its own. A payment can only arrive if someone
 * sent it, and the send is where the check already happened.
 */
export const BETA_USD_CAP = 500;

/**
 * Whether an amount is worth more than the cap allows.
 *
 * An unknown price means unknown dollars, so the check stands aside rather than
 * blocking a token it cannot value. A guardrail that guesses at the number it
 * is enforcing is worse than one with a known hole in it.
 */
export function overBetaCap(amount: number, priceUsd: number | null): boolean {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return amount * priceUsd > BETA_USD_CAP;
}
