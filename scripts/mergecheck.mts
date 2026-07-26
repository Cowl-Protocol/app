// Merge-check: a fragmented book really does reach the amount it is told it
// will. Run with:  npx tsx scripts/mergecheck.mts
//
// A spend reads two notes, so a balance spread thin can hold far more than any
// one send can move. Merging fixes that, and the screen promises a number of
// rounds before anyone signs the first. If that count is wrong the run stops
// short and the send is still capped, having spent gas to get there.
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

/** Apply one merge the way the executor does: two smallest become one. */
function mergeOnce(w: Wallet): Wallet {
  const live = w.notes
    .filter((n) => !n.spent)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1));
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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
