// Transport-check: a throttled endpoint is not a malformed request. Run with:
//   npx tsx scripts/transportcheck.mts
//
// The bug this guards against was a word collision that cost minutes per
// operation. The fallback surfaces some errors immediately instead of trying
// the next endpoint, which is right for "that block range is too wide" — the
// next node answers the same way, so asking it is waste. It was recognised by
//
//     /limit|range|exceed|too (?:many|large|broad)/i
//
// and the explorer refuses with "Too many requests. Increase limits now at …".
// Two matches in one sentence. So a rate limit — which is about that endpoint
// and nothing else — was read as "nobody will serve this", the chain stopped
// there, and the one endpoint answering this chain's historical logs in under
// half a second was never asked. A merge that should take seconds sat on
// "Reading the chain".
//
// The property: an error that is about the endpoint must fall through, and an
// error that is about the request must not. Both directions matter — surfacing
// nothing would spend every endpoint's timeout on a revert, which is the waste
// the rule was written to stop in the first place.
import { readFileSync } from "node:fs";

import { surfaceImmediately } from "../lib/transport";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// The real classifier, not a restatement of it. Everything below drives the
// function the transport actually installs, so a change to it that breaks one
// of these cases turns this red rather than leaving a check testing a copy of
// the old behaviour.
const surfaces = (message: string): boolean => surfaceImmediately(new Error(message));

// The retry policy is configuration rather than a function, so that one case is
// still read out of the source.
const src = readFileSync("lib/transport.ts", "utf8");

// --- what must fall through: the endpoint's own state ------------------------
const FALL_THROUGH = [
  // The exact body blockscout returns, which started all of this.
  'HTTP request failed.\n\nStatus: 429\nDetails: {"message":"Too many requests. Increase limits now at https://dev.blockscout.com","result":null,"status":"0"}',
  "HTTP request failed.\n\nStatus: 429",
  "rate limit exceeded, please try again later",
  "Rate-limited by the provider",
  "daily quota exceeded for this key",
];
for (const m of FALL_THROUGH) {
  check(`falls through: ${m.split("\n")[0].slice(0, 46)}`, surfaces(m) === false);
}

// --- what must still surface: the request's own shape ------------------------
const SURFACE = [
  "eth_getLogs: block range too large, max 10000",
  "query returned more than 10000 results",
  "requested block range exceeds the limit",
  "Log response size exceeded. Limit: 150MB",
  "execution reverted: ERC20: transfer amount exceeds balance",
  "The contract function reverted with the following reason: UnknownRoot",
];
for (const m of SURFACE) {
  check(`still surfaces: ${m.slice(0, 46)}`, surfaces(m) === true);
}

// --- the one that decides it, spelled out ------------------------------------
// A rate limit and a range cap read almost identically in English. This pair is
// the whole finding, so it is asserted as a pair.
{
  const limitByEndpoint = "Too many requests. Increase limits now at https://dev.blockscout.com";
  const limitByRequest = "too many results, narrow your block range";
  check(
    "the same two words mean opposite things, and are told apart",
    surfaces(limitByEndpoint) === false && surfaces(limitByRequest) === true,
    `endpoint=${surfaces(limitByEndpoint)} request=${surfaces(limitByRequest)}`,
  );
}

// --- patience only where there is nothing left to try ------------------------
// The explorer's spaced retries are right as a last resort and wrong in front
// of a working endpoint: three rounds three seconds apart, per request, on a
// node that has already refused.
{
  const mid = /lastResort \? 3 : 0/.test(src);
  const cond = /const lastResort = i === urls\.length - 1/.test(src);
  check("the explorer only waits patiently when it is last", mid && cond);
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
