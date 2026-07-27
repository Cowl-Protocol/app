// Cap-check: the beta ceiling blocks what it should and, more importantly,
// stands aside everywhere else. Run with:
//   npx tsx scripts/capcheck.mts
//
// A guardrail that fires when it should not is worse than no guardrail: it
// blocks a move nobody can explain, on a screen that offers no way around it.
// So most of what follows checks the cases where the answer must be no.
//
// The cap covers deposits and private sends. It must never reach a withdrawal,
// which is checked as its own case at the end, because a ceiling on the way out
// would strand exactly the people it claims to protect.
import { readFileSync } from "node:fs";
import { BETA_USD_CAP, overBetaCap } from "../lib/betaLimits";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log(`\nBeta cap: $${BETA_USD_CAP}\n`);

// ---- the cap does its job ---------------------------------------------------

// Derived from the cap, not written as dollars: the first version hardcoded
// the launch-day $500 and turned red the day the cap moved to $200, which is
// the assertion pinning the number instead of the property. The property is
// that the boundary sits exactly at BETA_USD_CAP, wherever that is.
check(
  "well under the cap passes",
  overBetaCap(1, BETA_USD_CAP / 2) === false,
  `1 × $${BETA_USD_CAP / 2}`,
);
check(
  "just under the cap passes",
  overBetaCap(BETA_USD_CAP - 1, 1) === false,
  `${BETA_USD_CAP - 1} × $1`,
);
check(
  "exactly at the cap passes",
  overBetaCap(BETA_USD_CAP, 1) === false,
  `${BETA_USD_CAP} × $1`,
);
check(
  "a cent over the cap blocks",
  overBetaCap(BETA_USD_CAP + 0.01, 1) === true,
  `$${(BETA_USD_CAP + 0.01).toFixed(2)}`,
);
check("far over the cap blocks", overBetaCap(1000, 100) === true, "$100,000");

// A cheap token in huge quantity is the case a naive token-denominated cap
// would miss entirely, and the case a dollar cap exists to catch. The passing
// case sits clearly under the cap rather than exactly at it, because a product
// of five million times a tiny float lands near the line with rounding noise,
// and this check is about counts, not about the boundary — the boundary has
// its own checks above.
check(
  "a cheap token in size blocks on dollars, not on count",
  overBetaCap(5_000_000, (BETA_USD_CAP * 10) / 5_000_000) === true,
  `5,000,000 × $${(BETA_USD_CAP * 10) / 5_000_000} = $${BETA_USD_CAP * 10}`,
);
check(
  "the same count of a cheaper token passes",
  overBetaCap(5_000_000, BETA_USD_CAP / 2 / 5_000_000) === false,
  `5,000,000 × $${BETA_USD_CAP / 2 / 5_000_000} = $${BETA_USD_CAP / 2}`,
);

// ---- the cap stands aside ---------------------------------------------------

check("an unpriced token is never blocked", overBetaCap(1e9, null) === false, "price unknown");
check("a zero price is never blocked", overBetaCap(1e9, 0) === false);
check("a negative price is never blocked", overBetaCap(1e9, -5) === false);
check("an infinite price is never blocked", overBetaCap(1, Infinity) === false);
check("a NaN price is never blocked", overBetaCap(1, NaN) === false);
check("an empty amount is never blocked", overBetaCap(0, 100) === false);
check("a NaN amount is never blocked", overBetaCap(NaN, 100) === false);
check("a negative amount is never blocked", overBetaCap(-1000, 100) === false);

// ---- the boundary, exactly --------------------------------------------------

// Floating point decides this one, so it is worth pinning rather than assuming.
const atCap = BETA_USD_CAP / 3;
check(
  "a third of the cap, three times over, still passes",
  overBetaCap(atCap * 3, 1) === false,
  `${(atCap * 3).toFixed(10)} × $1`,
);

// ---- which surfaces the cap actually reaches --------------------------------

// The arithmetic above proves the function is right. It says nothing about
// where it is wired, and wiring it to the wrong screen is the failure that
// costs someone their exit. So read the cards and assert on the gates
// themselves: if a later edit drops the shield qualifier, this fails loudly
// instead of quietly capping withdrawals.
const shieldCard = readFileSync(new URL("../components/ShieldCard.tsx", import.meta.url), "utf8");
const sendCard = readFileSync(new URL("../components/SendCard.tsx", import.meta.url), "utf8");

check(
  "the boundary card caps deposits only",
  /const overCap = mode === "shield" && overBetaCap\(/.test(shieldCard),
  "mode === shield qualifier present",
);
check("the boundary card gates on the cap", /!overCap\b/.test(shieldCard));
check("the send card gates on the cap", /!overCap\b/.test(sendCard));
check(
  "no card gates a withdrawal on the cap",
  !/mode === "unshield" && overBetaCap/.test(shieldCard) &&
    !/unshield[\s\S]{0,40}overBetaCap/.test(shieldCard),
);
check(
  "both cards show the dollar figure before signing",
  /usd=\{usd\}/.test(shieldCard) && /usd=\{usd\}/.test(sendCard),
  "passed into the confirm panel",
);

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check${failures === 1 ? "" : "s"} failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
