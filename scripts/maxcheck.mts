// Max-check: the way out never offers an amount it cannot carry. Run with:
//   npx tsx scripts/maxcheck.mts
//
// The bug this guards against was a button lying. A join-split reads two notes
// and writes two, so a book spread across three or more holds more than any one
// spend can move — and the unshield card's MAX wrote the whole balance anyway.
// Every check on the screen passed, the review opened, and the run died inside
// the planner on "Shielded balance is too fragmented: no two notes cover it".
// The wall was reached by pressing the button the card offered.
//
// So the property is not "the arithmetic agrees with itself". It is that the
// card's answer agrees with `selectUpTo2`, the real selector that threw, and
// with `mergesNeeded`, the real count of rounds behind the merge it offers.
// Both are imported here rather than restated: a second opinion about what the
// planner does is exactly what put the wrong number on the button.
import { selectUpTo2, mergesNeeded, computeBalance, type Wallet } from "../lib/shielded/pool";
import { maxDeliverable, withdrawVerdict } from "../lib/shielded/deliverable";
import { maxAfterFee } from "../lib/denominations";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const TOKEN = 0n; // native, the case in the report
const hex = (v: bigint) => `0x${v.toString(16)}`;
const book = (values: bigint[]): Wallet => ({
  notes: values.map((v, i) => ({
    value: hex(v),
    token: hex(TOKEN),
    blinding: hex(1n),
    leafIndex: i,
    spent: false,
  })),
});
const holds = (w: Wallet) => computeBalance(w).find((b) => b.token === TOKEN) ?? { amount: 0n, notes: 0 };
/** The two largest, which is the whole of what one spend reaches. */
const twoLargest = (values: bigint[]) =>
  [...values].sort((a, b) => (a < b ? 1 : -1)).slice(0, 2).reduce((s, v) => s + v, 0n);

/** Does the planner accept this draw against this book? */
function plannerTakes(w: Wallet, need: bigint): boolean {
  try {
    selectUpTo2(w, TOKEN, need);
    return true;
  } catch {
    return false;
  }
}

// The book from the report, to the wei: 0.037991402507505497 ETH that no two
// notes covered. Three notes, none of them the whole thing.
const REPORTED = [15_000_000_000_000_000n, 12_991_402_507_505_497n, 10_000_000_000_000_000n];

// --- 1. the reported failure, reproduced then closed -------------------------
{
  const w = book(REPORTED);
  const { amount, notes } = holds(w);
  check(
    "the reported book really is unspendable in one go",
    !plannerTakes(w, amount),
    `${notes} notes, balance ${amount}`,
  );

  // What the button used to write: the whole balance, self-paid so no fee hid it.
  const before = maxAfterFee(amount, 0n, 18, true);
  check("the old MAX wrote an amount the planner refuses", !plannerTakes(w, before), `${before}`);

  // What it writes now, and what the card says about it.
  const after = maxAfterFee(maxDeliverable(amount, notes, 0n), 0n, 18, true);
  const verdict = withdrawVerdict({
    balance: amount,
    sendable: twoLargest(REPORTED),
    noteCount: notes,
    parts: [after],
    feePerPart: 0n,
  });
  check("the card now names the step instead of running into the wall", verdict === "merge-first", verdict);
  check(
    "...and the merge it offers can actually reach the amount",
    mergesNeeded(w, TOKEN, after, 0n) >= 0,
    `${mergesNeeded(w, TOKEN, after, 0n)} rounds`,
  );
}

// --- 2. the property, over books the planner is asked about ------------------
// Whatever MAX writes, the card must never say `ok` on a draw the planner will
// refuse. That is the whole bug, stated as an invariant.
{
  const FEE = 55_625_000_000_000n; // one relayed spend, mainnet order of magnitude
  const books: bigint[][] = [
    [10n ** 18n], // one note
    [5n * 10n ** 17n, 5n * 10n ** 17n], // two, exactly reachable
    REPORTED, // three, the report
    Array.from({ length: 9 }, () => 10n ** 16n), // nine crumbs
    Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * 10n ** 15n), // a long tail
    [10n ** 18n, 1n, 1n], // one big, two dust
    [FEE / 2n, FEE / 2n, FEE / 2n], // a book smaller than one fee, relayed
  ];

  let lies = 0;
  let offered = 0;
  const notes: string[] = [];
  for (const values of books) {
    for (const fee of [0n, FEE]) {
      for (const exact of [true, false]) {
        const w = book(values);
        const { amount, notes: n } = holds(w);
        const written = maxAfterFee(maxDeliverable(amount, n, fee), fee, 18, exact);
        if (written <= 0n) continue;
        offered++;
        const verdict = withdrawVerdict({
          balance: amount,
          sendable: twoLargest(values),
          noteCount: n,
          parts: [written],
          feePerPart: fee,
        });
        if (verdict !== "ok") continue; // the card refused; nothing was promised
        if (!plannerTakes(w, written + fee)) {
          lies++;
          notes.push(`${values.length} notes fee=${fee} exact=${exact} -> ${written}`);
        }
      }
    }
  }
  check(
    "MAX never writes an amount the card calls ok and the planner refuses",
    lies === 0,
    `${offered} offers checked, ${lies} bad${notes.length ? `: ${notes[0]}` : ""}`,
  );
}

// --- 3. the merge it offers is a real one ------------------------------------
// "Merge notes first" is a promise that merging gets there. When it cannot, the
// card owes the other answer — over-reach — before the run pays for a round.
{
  const FEE = 55_625_000_000_000n;
  let broken = 0;
  let promises = 0;
  for (const values of [REPORTED, Array.from({ length: 12 }, () => 10n ** 16n), [FEE, FEE, FEE]]) {
    for (const fee of [0n, FEE]) {
      const w = book(values);
      const { amount, notes: n } = holds(w);
      const written = maxAfterFee(maxDeliverable(amount, n, fee), fee, 18, true);
      if (written <= 0n) continue;
      const verdict = withdrawVerdict({
        balance: amount,
        sendable: twoLargest(values),
        noteCount: n,
        parts: [written],
        feePerPart: fee,
      });
      if (verdict !== "merge-first") continue;
      promises++;
      if (mergesNeeded(w, TOKEN, written + fee, fee) < 0) broken++;
    }
  }
  check("every merge the card offers can reach the amount", broken === 0, `${promises} offers, ${broken} unreachable`);
}

// --- 4. the answers stay in the order someone can act on ---------------------
{
  const v = (parts: bigint[], balance: bigint, sendable: bigint, noteCount: number, fee: bigint) =>
    withdrawVerdict({ balance, sendable, noteCount, parts, feePerPart: fee });

  check("more than the book holds reads as insufficient", v([10n], 5n, 5n, 1, 0n) === "insufficient");
  check("a book in two notes needs no merge", v([5n], 10n, 10n, 2, 0n) === "ok");
  check("a fragmented book asks for the merge", v([9n], 10n, 5n, 3, 0n) === "merge-first");
  check(
    "fees that eat the difference read as over-reach, not as a merge",
    v([90n], 100n, 100n, 10, 2n) === "over-reach",
  );
  check("nothing typed is never a refusal", v([], 0n, 0n, 0, 0n) === "ok");
  // The relayer's fee comes out of the same two notes the amount does, so a
  // part that fits on its own can still not fit once the fee rides along. This
  // one is here because a mutation that dropped `+ feePerPart` survived
  // everything else in this file.
  check(
    "the fee is part of what one spend has to cover",
    v([5n], 100n, 5n, 3, 1n) === "merge-first",
    v([5n], 100n, 5n, 3, 1n),
  );
  // Shared splits a withdrawal into several spends, each its own join-split, so
  // the ceiling is the biggest part rather than their sum.
  check(
    "with several parts the biggest one decides, not the total",
    v([4n, 4n, 4n], 100n, 5n, 5, 0n) === "ok",
  );
  check("...and a part above the ceiling still asks for the merge", v([6n, 4n], 100n, 5n, 5, 0n) === "merge-first");
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
