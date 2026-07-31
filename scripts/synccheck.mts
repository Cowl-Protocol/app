// Sync-check: a balance refresh stops waiting, and says so. Run with:
//   npx tsx scripts/synccheck.mts
//
// The bug this guards against had no error, no timeout and no way out. Every
// endpoint that serves this chain's history refused at once — publicnode wants
// a token for an archive read, the explorer rate-limits, and a hijacked
// resolver took the third away — so the chain read never settled. `syncing` was
// cleared in a `finally` on an unbounded await, which meant it was never
// cleared at all: the spinner beside the balance spun until the tab was closed,
// and nothing on screen could tell "still working" from "there is nothing left
// to ask".
//
// Two properties have to hold, and the second is the one worth guarding:
//
//   1. The wait ends. Bounded by the deadline, whatever the chain does.
//   2. The screen never goes quiet about it. Stopping the spinner alone would
//      turn a confusing truth into a comfortable wrong answer — a page that
//      looks freshly synced while showing the stored book. Every path that
//      stops the spinner without publishing must raise the stale mark.
//
// Unlike its siblings this imports the real decision rather than modelling it,
// because a model of this one drifts back invisibly: the failure looks exactly
// like the screen working.
import { awaitSync, singleFlight } from "../lib/shielded/refresh";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// A check that dies is not a verdict. Both of the failures this file guards
// against can kill the process instead of reporting: an unbounded wait hangs,
// and a promise nobody handles takes the runtime down. Turn each into a FAIL.
process.on("unhandledRejection", (e) => {
  check("no promise is left unhandled", false, String(e).split("\n")[0]);
});

/** Bound anything that is supposed to be bounded, so a hang reports. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T | null> {
  const hung = Symbol("hung");
  const race = await Promise.race([work, sleep(ms).then(() => hung)]);
  if (race === hung) {
    check(what, false, `never returned within ${ms}ms`);
    return null;
  }
  return race as T;
}

const DEADLINE = 60;
const never = () => new Promise<"ok" | "failed">(() => {});
const lands = (ms: number, as: "ok" | "failed" = "ok") =>
  new Promise<"ok" | "failed">((r) => setTimeout(() => r(as), ms));

// --- 1. the bug itself: a read that never comes back ------------------------
{
  const started = Date.now();
  const v = await within(awaitSync(never(), DEADLINE), DEADLINE * 10, "a read that never lands stops the wait");
  if (v) {
    const waited = Date.now() - started;
    check("a read that never lands stops the wait", waited < DEADLINE * 5, `${waited}ms`);
    check("...and does not publish a book it never read", v.publish === false);
    check("...and raises the stale mark", v.stale === true);
    check("...and keeps the late path armed", v.outlived === true);
  }
}

// --- 2. the honesty property, over every outcome ----------------------------
// Whatever happens, the screen must not be left looking fresh while showing the
// stored book. Publishing and marking stale are the only two acceptable ends.
{
  const cases: [string, Promise<"ok" | "failed">][] = [
    ["landed", lands(5)],
    ["failed fast", lands(5, "failed")],
    ["never landed", never()],
    ["landed on the deadline", lands(DEADLINE)],
  ];
  let honest = true;
  const seen: string[] = [];
  for (const [name, read] of cases) {
    // Bounded here too: an unbounded awaitSync would hang the whole file at the
    // "never landed" case, after test 1 had already named the fault. A check
    // that reports once and then stops is only half a verdict.
    const v = await within(awaitSync(read, DEADLINE), DEADLINE * 10, `the ${name} case returns`);
    if (!v) { honest = false; continue; }
    if (v.publish === v.stale) honest = false; // exactly one of the two, always
    seen.push(`${name}=${v.publish ? "published" : "stale"}`);
  }
  check("every outcome either publishes or marks stale, never neither", honest, seen.join(" "));
}

// --- 3. a failed read is not left waiting for a landing that cannot come ----
{
  const v = await awaitSync(lands(5, "failed"), DEADLINE);
  check("a read that failed is not treated as still running", v.outlived === false);
  check("...and still marks stale", v.stale === true);
}

// --- 4. a healthy read is untouched by any of this --------------------------
{
  const v = await awaitSync(lands(5), DEADLINE);
  check("a read that lands publishes", v.publish === true);
  check("...with no stale mark", v.stale === false);
}

// --- 5. the late landing that clears the mark -------------------------------
// The deadline abandons the wait, not the work. A slow endpoint has to be able
// to correct the screen on its own, or the mark is permanent until someone
// presses refresh.
{
  const read = lands(DEADLINE * 3);
  const v = await awaitSync(read, DEADLINE);
  check("a slow read is marked stale first", v.stale && v.outlived);
  const late = await read;
  check("...and still lands afterwards, so the mark can come down", late === "ok");
}

// --- 6. one read at a time ---------------------------------------------------
// The deadline returns while the read is still going, so a second refresh in
// that window must join the first. Two full replays writing one stored book is
// the hazard this closes.
{
  const one = singleFlight<"ok" | "failed">();
  let starts = 0;
  const start = () => {
    starts++;
    return lands(30);
  };
  const a = one(start);
  const b = one(start);
  check("a refresh during a running read joins it", starts === 1 && a === b, `${starts} started`);
  await Promise.all([a, b]);
  one(start);
  check("...and the next refresh after it settles starts a fresh read", starts === 2);
}

// --- 7. a failed read frees the slot ----------------------------------------
// If the slot only freed on success, one failure would wedge every later
// refresh onto a promise that had already settled — the same spinner, by a
// different route.
{
  const one = singleFlight<"ok" | "failed">();
  let starts = 0;
  const start = () => {
    starts++;
    return Promise.reject(new Error("every endpoint refused"));
  };
  await one(start).catch(() => {});
  await sleep(5);
  await one(start).catch(() => {});
  check("a failed read frees the slot for the next attempt", starts === 2, `${starts} started`);
}

await sleep(20); // let a stray rejection surface before the tally
console.log(failures === 0 ? "\nall green" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
