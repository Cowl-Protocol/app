// Merge-check: a fragmented book really does reach the amount it is told it
// will. Run with:  npx tsx scripts/mergecheck.mts
//
// A spend reads two notes, so a balance spread thin can hold far more than any
// one send can move. Merging fixes that, and the screen promises a number of
// rounds before anyone signs the first. If that count is wrong the run stops
// short and the send is still capped, having spent gas to get there.
import { readFileSync } from "node:fs";
import { mergesNeeded, planConsolidate, emptyPool, emptyWallet, type Wallet } from "../lib/shielded/pool";
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
