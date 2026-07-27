// Merge-check: a fragmented book really does reach the amount it is told it
// will. Run with:  npx tsx scripts/mergecheck.mts
//
// A spend reads two notes, so a balance spread thin can hold far more than any
// one send can move. Merging fixes that, and the screen promises a number of
// rounds before anyone signs the first. If that count is wrong the run stops
// short and the send is still capped, having spent gas to get there.
import { readFileSync } from "node:fs";
import { mergesNeeded, planConsolidate, selectUpTo2, emptyPool, emptyWallet, type Wallet } from "../lib/shielded/pool";
import { fieldToHex } from "../lib/shielded/field";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const ONE = 10n ** 18n;
const TOKEN = 0n;

/** A book holding exactly these note values, all live. */
function bookOf(values: bigint[]): Wallet {
  const w = emptyWallet();
  w.notes = values.map((v, i) => ({
    value: fieldToHex(v),
    token: fieldToHex(TOKEN),
    blinding: fieldToHex(BigInt(i + 1)),
    leafIndex: i,
    spent: false,
  }));
  return w;
}

/** What one spend can move: the two largest notes. */
function sendable(w: Wallet): bigint {
  return w.notes
    .filter((n) => !n.spent)
    .map((n) => BigInt(n.value))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, 2)
    .reduce((s, v) => s + v, 0n);
}

/** Apply one merge the way the executor does: the two largest become one. */
function mergeOnce(w: Wallet): Wallet {
  const live = w.notes
    .filter((n) => !n.spent)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? 1 : -1));
  const [a, b] = [live[0]!, live[1]!];
  const rest = live.slice(2);
  const merged = BigInt(a.value) + BigInt(b.value);
  return bookOf([...rest.map((n) => BigInt(n.value)), merged]);
}

// ---- the book on the user's screen -------------------------------------------
// 750,000 across denominated shields; the two largest come to 200,000.
const denominated = [
  100_000n, 100_000n, 100_000n, 100_000n, 100_000n, 100_000n, 100_000n, 50_000n,
].map((v) => v * ONE);

let book = bookOf(denominated);
check("the cap starts where the screen said", sendable(book) === 200_000n * ONE, `${sendable(book) / ONE}`);

const target = 500_000n * ONE;
const rounds = mergesNeeded(book, TOKEN, target);
check("a round count is offered", rounds > 0, `${rounds} merges`);

for (let i = 0; i < rounds; i++) book = mergeOnce(book);
check(
  "after exactly that many rounds the amount fits",
  sendable(book) >= target,
  `${sendable(book) / ONE} covers ${target / ONE}`,
);

// One round fewer must NOT be enough, or the count is padded.
let short = bookOf(denominated);
for (let i = 0; i < rounds - 1; i++) short = mergeOnce(short);
check("and one round fewer is not enough", sendable(short) < target, `${sendable(short) / ONE}`);

// ---- the cases that should not promise anything -------------------------------
check(
  "an amount larger than the whole book is refused",
  mergesNeeded(bookOf(denominated), TOKEN, 10_000_000n * ONE) === -1,
);
check("an amount that already fits needs no merges", mergesNeeded(bookOf(denominated), TOKEN, 150_000n * ONE) === 0);
check(
  "two notes cannot be merged further",
  (() => {
    try {
      planConsolidate(emptyPool(), bookOf([1n * ONE, 2n * ONE]), { mpk: 1n } as never, TOKEN, 1n);
      return false;
    } catch {
      return true;
    }
  })(),
);

// ---- value is never created or destroyed --------------------------------------
const before = denominated.reduce((s, v) => s + v, 0n);
const after = book.notes.filter((n) => !n.spent).reduce((s, n) => s + BigInt(n.value), 0n);
check("merging conserves the balance to the wei", before === after, `${before / ONE} COWL both sides`);

// The strategy is the point: merging the two smallest reached the same target
// in five rounds, and one of those five raised the ceiling by nothing.
const smallestFirst = (() => {
  let v = denominated.map((x) => x).sort((a, b) => (a < b ? -1 : 1));
  const top2 = (x: bigint[]) => [...x].sort((a, b) => (a < b ? 1 : -1)).slice(0, 2).reduce((s, y) => s + y, 0n);
  let n = 0;
  while (top2(v) < target && v.length >= 3) {
    v = [...v.slice(2), v[0]! + v[1]!].sort((a, b) => (a < b ? -1 : 1));
    n++;
  }
  return n;
})();
check(
  "merging the largest beats merging the smallest",
  rounds < smallestFirst,
  `${rounds} rounds instead of ${smallestFirst}`,
);

// ---- what a relayer costs a run ---------------------------------------------
// A relayed round pays its fee out of the pair being merged, so every round
// mints a note smaller than the two it retired. Left out of the count, the
// number on screen reads low, the run stops short, and the send it was clearing
// the way for is still capped — after paying for every round. So the fee has to
// be in the arithmetic, not just in the plan.
{
  const FEE = 5_000n * ONE;

  /** One relayed round, exactly as planConsolidate performs it. */
  const mergeOncePaid = (w: Wallet, fee: bigint): Wallet => {
    const live = w.notes
      .filter((n) => !n.spent)
      .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? 1 : -1));
    const [a, b] = [live[0]!, live[1]!];
    return bookOf([...live.slice(2).map((n) => BigInt(n.value)), BigInt(a.value) + BigInt(b.value) - fee]);
  };

  const paidRounds = mergesNeeded(bookOf(denominated), TOKEN, target, FEE);
  check("a fee is allowed to change the count", paidRounds > 0, `${paidRounds} rounds with a fee`);
  check(
    "and it never lowers it",
    paidRounds >= rounds,
    `${paidRounds} paid vs ${rounds} free`,
  );

  let paid = bookOf(denominated);
  for (let i = 0; i < paidRounds; i++) paid = mergeOncePaid(paid, FEE);
  check(
    "after that many paid rounds the amount still fits",
    sendable(paid) >= target,
    `${sendable(paid) / ONE} covers ${target / ONE}`,
  );

  // The failure this whole block exists to prevent: counting as though the
  // rounds were free and then paying for them.
  let underCounted = bookOf(denominated);
  for (let i = 0; i < rounds; i++) underCounted = mergeOncePaid(underCounted, FEE);
  check(
    "counting free rounds and paying for them falls short",
    sendable(underCounted) < target,
    `${sendable(underCounted) / ONE} short of ${target / ONE} — which is why the fee is in the count`,
  );

  // Value is conserved minus exactly what the relayer was paid, never more.
  const spent = paid.notes.filter((n) => !n.spent).reduce((s, n) => s + BigInt(n.value), 0n);
  check(
    "a paid run loses exactly the fees and nothing else",
    spent === before - FEE * BigInt(paidRounds),
    `${(before - spent) / ONE} paid over ${paidRounds} rounds`,
  );

  // A fee big enough to swallow the pair makes merging pointless rather than
  // endless: the count says so instead of looping.
  check(
    "a fee larger than the book is refused, not looped",
    mergesNeeded(bookOf(denominated), TOKEN, target, 10_000_000n * ONE) === -1,
  );

  // And the plan refuses the same case rather than building an impossible witness.
  check(
    "a round that cannot cover its own fee is refused",
    (() => {
      try {
        planConsolidate(
          emptyPool(),
          bookOf([1n * ONE, 2n * ONE, 3n * ONE]),
          { mpk: 1n, viewPubHex: "00" } as never,
          TOKEN,
          1n,
          100n * ONE,
          1n,
        );
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // A free merge names no asset; a paid one has to, because the fee is value
  // leaving and the circuit pins the field the moment anything does.
  const free = planConsolidate(emptyPool(), bookOf(denominated), { mpk: 1n, viewPubHex: "00" } as never, TOKEN, 1n);
  const withFee = planConsolidate(
    emptyPool(),
    bookOf(denominated),
    { mpk: 1n, viewPubHex: "00" } as never,
    TOKEN,
    1n,
    FEE,
    0xbeefn,
  );
  check("a self-paid merge names no asset", free.plan.publicToken === 0n);
  check("a relayed merge names its asset", withFee.plan.publicToken === TOKEN);
  check("the fee leaves the merged note smaller", withFee.outputs[0]!.note.value === free.outputs[0]!.note.value - FEE);
}

// ---- spending does not demolish what merging built ---------------------------
// The cycle that costs real money: merge up to a ceiling, pay a small amount,
// and watch the payment reach past a pile of small notes for the big one the
// merges just built. Every such payment buys another round of merge fees. Two
// inputs cost exactly what one costs, so preferring the selection that leaves
// the highest ceiling is free.
{
  const merged = 3_987_322n * ONE;
  const book = bookOf([merged, ...Array.from({ length: 8 }, () => 1_000_000n * ONE)]);
  const FEE = 4_657n * ONE;
  const ceilingAfter = (picked: bigint[], change: bigint) => {
    const rest = [merged, ...Array.from({ length: 8 }, () => 1_000_000n * ONE)];
    for (const p of picked) rest.splice(rest.indexOf(p), 1);
    const after = [...rest, ...(change > 0n ? [change] : [])].sort((a, b) => (a < b ? 1 : -1));
    return (after[0] ?? 0n) + (after[1] ?? 0n);
  };
  const spend = (amount: bigint) => {
    const need = amount + FEE;
    const picked = selectUpTo2(book, TOKEN, need).map((n) => BigInt(n.value));
    const total = picked.reduce((s, v) => s + v, 0n);
    return { picked, ceiling: ceilingAfter(picked, total - need), ate: picked.includes(merged) };
  };

  // Below the merged note's own size the old rule already behaved; the point is
  // it now also consolidates on the way past, lifting the ceiling rather than
  // shaving a small note off the pile.
  const small = spend(500_000n * ONE);
  check("a small payment leaves the merged note alone", !small.ate);
  check("and lifts the ceiling on its way", small.ceiling > merged + 1_000_000n * ONE, `${small.ceiling / ONE}`);

  // This is the case that used to cost a re-merge: two 1M notes cover it, so
  // the 4M note has no business being spent.
  const mid = spend(1_500_000n * ONE);
  check("a payment two small notes can cover leaves the merged note alone", !mid.ate);
  check("so the ceiling does not move", mid.ceiling === merged + 1_000_000n * ONE, `${mid.ceiling / ONE}`);

  // Past what the small notes can carry the merged note has to go — but pairing
  // it beats spending it alone, because the change comes back as one note
  // instead of leaving the pile behind.
  const big = spend(2_000_000n * ONE);
  check("a payment beyond them spends it, as it must", big.ate);
  const alone = merged - (2_000_000n * ONE + FEE);
  check(
    "and pairs it rather than stranding the change",
    big.ceiling > alone + 1_000_000n * ONE,
    `${big.ceiling / ONE} against ${(alone + 1_000_000n * ONE) / ONE} if spent alone`,
  );

  // Never at the cost of correctness: the selection has to actually cover.
  for (const amt of [100_000n, 500_000n, 1_500_000n, 2_000_000n, 4_500_000n]) {
    const need = amt * ONE + FEE;
    const total = selectUpTo2(book, TOKEN, need).reduce((s, n) => s + BigInt(n.value), 0n);
    if (total < need) check(`selection covers ${amt}`, false);
  }
  check("every selection covers what it was asked for", true);
}

// ---- the merge / spend / merge cycle, run to exhaustion ----------------------
// The worry this answers: a note is merged, then broken up again by a small
// payment, over and over. Nothing may be conjured or lost across a hundred of
// those, and the loop must end on a reason rather than spin.
{
  const FEE = 4_250n * ONE;
  let vals = Array.from({ length: 12 }, () => 1_000_000n * ONE);
  const opening = vals.reduce((s, v) => s + v, 0n);
  let sent = 0n, fees = 0n, merges = 0, sends = 0, broke = "";
  const top2 = (v: bigint[]) => [...v].sort((a, b) => (a < b ? 1 : -1)).slice(0, 2).reduce((s, x) => s + x, 0n);

  cycles: for (let c = 0; c < 40 && !broke; c++) {
    let guard = 0;
    while (mergesNeeded(bookOf(vals), TOKEN, top2(vals) + ONE, FEE) > 0) {
      if (++guard > 60) { broke = "merge loop did not converge"; break cycles; }
      const p = planConsolidate(emptyPool(), bookOf(vals), { mpk: 1n, viewPubHex: "00" } as never, TOKEN, 1n, FEE, 1n);
      const outs = p.outputs.map((o) => o.note.value);
      if (outs.some((v) => v < 0n)) { broke = "negative output"; break cycles; }
      vals = [...vals.filter((_, i) => !p.inputLeaves.includes(i)), ...outs.filter((v) => v > 0n)];
      fees += FEE; merges++;
    }
    const pay = top2(vals) / 10n;
    if (pay <= FEE) break;
    let picked;
    try { picked = selectUpTo2(bookOf(vals), TOKEN, pay + FEE); } catch { break; }
    const drawn = picked.reduce((s, n) => s + BigInt(n.value), 0n);
    const change = drawn - pay - FEE;
    if (change < 0n) { broke = "negative change"; break; }
    vals = [...vals.filter((_, i) => !picked.some((p) => p.leafIndex === i)), ...(change > 0n ? [change] : [])];
    sent += pay; fees += FEE; sends++;
  }

  const held = vals.reduce((s, v) => s + v, 0n);
  check("the cycle never breaks an invariant", !broke, broke || `${merges} merges, ${sends} sends`);
  check(
    "and conserves to the wei across all of it",
    opening - sent - fees - held === 0n,
    `${(opening - held) / ONE} left the book over ${merges + sends} spends`,
  );
  // The whole point of the selector change: far fewer rounds bought back.
  check("the cycle needs few merges, not one per payment", merges < sends, `${merges} merges for ${sends} payments`);
}

// ---- the wiring, read from the source ---------------------------------------
// planConsolidate accepting a fee proves nothing about anything passing one.
{
  const provider = readFileSync(new URL("../components/ShieldedProvider.tsx", import.meta.url), "utf8");
  const exec = provider.slice(provider.indexOf("const consolidateExec"), provider.indexOf("const value = useMemo"));
  check("consolidateExec is in the file", exec.length > 0);
  check("a merge run asks for a quote", /tryQuote\(/.test(exec));
  check("the fee reaches the round count", /mergesNeeded\([^)]*quote0\?\.fee|mergesNeeded\([\s\S]{0,120}?quote\?\.fee/.test(exec));
  check("the fee reaches the plan", /planConsolidate\([\s\S]{0,200}?quote\?\.fee/.test(exec));
  check("rounds go out through the relayer", /relaySpend\(/.test(exec));
  check("and fall back to the wallet without a quote", /submitSpend\(/.test(exec));
  check("it dry-runs as whoever submits", /simulateSpend\(\s*quote \? quote\.relayer/.test(exec));
  check("the screen is told who pays", /prog\.relayed/.test(exec));
  // A fee that climbs mid-run buys less ceiling per round than was counted on,
  // so a fixed round count can stop short. The loop re-asks the book instead,
  // and the cap is what keeps that from running forever.
  check("the run re-checks the book rather than trusting the estimate", /break merging/.test(exec));
  check("and is capped so a climbing fee cannot loop forever", /MAX_EXTRA_ROUNDS/.test(exec));

  const card = readFileSync(new URL("../components/SendCard.tsx", import.meta.url), "utf8");
  // "Nothing leaves your balance" stopped being true the moment a relayer was
  // paid out of the notes being merged.
  check("the merge panel no longer claims nothing leaves", !/Nothing\s+leaves your balance/.test(card));
  check("and it no longer says the two smallest", !/two smallest/.test(card));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
