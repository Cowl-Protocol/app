// Retry-check: a failed run resumes, it never restarts. Run with:
//   npx tsx scripts/retrycheck.mts
//
// The bug this guards against moved real money. A nine part shield failed on
// the last part, and Try again re-ran the whole plan: the eight deposits that
// had already landed were sent a second time, out of the wallet, for good.
//
// What is modelled here is the selection the executors make, not the wallet or
// the chain: which parts a run submits given the ones already on chain. That is
// exactly where the fault was, and the property it has to hold is arithmetic —
// across every attempt, each part is submitted once and the total that leaves
// the wallet equals the plan and never a wei more.

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

type PartTx = { hash: string; part: number };

/** The executors' loop, reduced to what it decides: the parts it submits. */
function submitted(parts: bigint[], done: PartTx[] = []): number[] {
  const landed = new Set(done.map((t) => t.part));
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (landed.has(i)) continue;
    out.push(i);
  }
  return out;
}

/** What the card carries into a retry: the landed parts, when the plan matches. */
function carryOver(
  prev: { error?: string; parts: bigint[]; txs: PartTx[] } | null,
  plan: bigint[],
): PartTx[] {
  const same =
    !!prev?.error && prev.parts.length === plan.length && prev.parts.every((p, i) => p === plan[i]);
  return same ? prev!.txs : [];
}

const PART = 100_000n * 10n ** 18n;
const plan = Array.from({ length: 9 }, () => PART);
const total = plan.reduce((s, p) => s + p, 0n);

// ---- a clean run -------------------------------------------------------------
check("a fresh run submits every part", submitted(plan).length === 9);

// ---- the failure that started this -------------------------------------------
// Eight landed, the ninth failed.
const landed: PartTx[] = Array.from({ length: 8 }, (_, i) => ({ hash: `0x${i}`, part: i }));
const failed = { error: "Rejected in the wallet.", parts: plan, txs: landed };

const resumeParts = submitted(plan, carryOver(failed, plan));
check("a retry submits only what is missing", resumeParts.length === 1, `part ${resumeParts[0]}`);
check("and it is the part that failed", resumeParts[0] === 8);

// The property that matters: a part whose deposit LANDED is never submitted
// again. Re-attempting the one that failed is right — it moved nothing.
const resentAfterLanding = resumeParts.filter((i) => landed.some((t) => t.part === i));
check("a landed part is never sent again", resentAfterLanding.length === 0);

const movedAcrossBoth =
  landed.reduce((s, t) => s + plan[t.part]!, 0n) + resumeParts.reduce((s, i) => s + plan[i]!, 0n);
check("the wallet pays the plan exactly once", movedAcrossBoth === total, `${movedAcrossBoth} wei`);

// ---- the guard that keeps a retry honest -------------------------------------
// Change the amount and the old run's receipts must not carry over, or parts
// would be skipped that this plan never sent.
const otherPlan = Array.from({ length: 9 }, () => 200_000n * 10n ** 18n);
check("a different plan carries nothing over", carryOver(failed, otherPlan).length === 0);
check("a shorter plan carries nothing over", carryOver(failed, plan.slice(0, 5)).length === 0);
// A run that finished has no error, so its receipts are not a resume either.
const finished = { parts: plan, txs: landed };
check("a finished run carries nothing over", carryOver(finished, plan).length === 0);

// ---- failure on the first part -----------------------------------------------
const noneLanded = { error: "boom", parts: plan, txs: [] as PartTx[] };
check(
  "nothing landed means the whole plan retries",
  submitted(plan, carryOver(noneLanded, plan)).length === 9,
);

// ---- every part landed but the run still errored -----------------------------
const allLanded: PartTx[] = plan.map((_, i) => ({ hash: `0x${i}`, part: i }));
check(
  "a run with nothing left submits nothing",
  submitted(plan, carryOver({ error: "late", parts: plan, txs: allLanded }, plan)).length === 0,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
