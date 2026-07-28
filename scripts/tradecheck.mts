// Trade-check: the in-app private swap's plan, wire format and quote path.
// Run with:  npx tsx scripts/tradecheck.mts
//
// A trade is a spend whose payout leg names the adapter, chained to a shield of
// the exact output. What this asserts is the part the browser cannot show:
//
//   1. the spend binds the adapter   recipient = adapter, value = the input cap
//   2. value conservation            inputs == change + cap + fee, to the wei
//   3. the legs chain                the shield proves against the root the spend makes
//   4. wire parity with the CLI      encodeTrade produces byte-identical JSON
//   5. the executor's promises       bare quote relayed, headroom self-paid,
//                                    stash before broadcast — pinned in source
//   6. the live venue prices it      QuoterV2 answers both route directions
//   7. the live relayer prices it    a trade fee is sized above a spend fee
//
// Signs nothing and moves nothing; the live half reads free eth_calls.
import { readFileSync } from "node:fs";
import { fieldToHex, hexToField, randomField } from "../lib/shielded/field";
import { commitment, type Note } from "../lib/shielded/note";
import { encryptNote } from "../lib/shielded/crypto";
import { deriveShieldedKeysFromSignature } from "../lib/shielded/keys";
import { appendProof, computeRoot } from "../lib/shielded/tree";
import { applyScan, emptyPool, emptyWallet, newNote, planUnshield } from "../lib/shielded/pool";
import {
  quoteBestExactInput,
  quoteBestExactOutput,
  quoteExactOutput,
  venueLeg,
  type TradeSubmission,
} from "../lib/shielded/contract";
import { encodeTrade, fetchQuote } from "../lib/relay";
import { tradeInputFor } from "../lib/trade";
import { NETWORKS } from "../lib/networks";
import { encodeTrade as cliEncodeTrade } from "../../cli/src/relayer/client";
import type { TradeSubmission as CliTradeSubmission } from "../../cli/src/shielded/contract";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const mainnet = NETWORKS["robinhood-mainnet"]!;
const CHAIN_ID = BigInt(mainnet.chainId);
const ETH = 0n;
const ADAPTER = BigInt(mainnet.contracts.tradeAdapter!);
const USDG = BigInt(mainnet.contracts.usdg!);

// ---- the route rule ---------------------------------------------------------
check("a token purchase pays in native", tradeInputFor(USDG) === 0n);
check("a sale back to native pays in USDG", tradeInputFor(0n) === USDG);

// ---- plan: the spend leg binds the adapter ----------------------------------
const trader = deriveShieldedKeysFromSignature("0x" + "c4".repeat(65));
const pool = emptyPool();
const held: Note = { value: 5n * 10n ** 16n, token: ETH, mpk: trader.mpk, blinding: randomField() };
pool.commitments.push(fieldToHex(randomField()), fieldToHex(commitment(held)));
pool.ciphertexts.push(null, encryptNote(held, trader.viewPubHex));
pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));

const wallet = emptyWallet();
applyScan(pool, wallet, trader);

const QUOTED = 539n * 10n ** 11n; // a realistic 0.1 USDG quote, in wei
const FEE = 10n ** 13n;
const RELAYER = BigInt("0x2C910370000000000000000000000000000000AB");

// Relayed: the cap is the bare quote. Self-paid gains 1% — asserted as the
// executor computes it, refund destination deciding which.
const capRelayed = QUOTED;
const capSelf = QUOTED + QUOTED / 100n;
check("self-paid headroom is 1% of the quote", capSelf - capRelayed === QUOTED / 100n);

const planned = planUnshield(pool, wallet, trader, capRelayed, ETH, ADAPTER, CHAIN_ID, FEE, RELAYER);
check("the spend's payout leg is the adapter", planned.plan.recipient === ADAPTER);
check("the public value is the input cap", planned.plan.publicValue === capRelayed);
check("a trade names its input token", planned.plan.publicToken === ETH && planned.plan.token === ETH);
check(
  "value conserved: input == change + cap + fee",
  planned.outputs[0]!.note.value + capRelayed + FEE === held.value &&
    planned.outputs[1]!.note.value === 0n,
);

// ---- the legs chain ---------------------------------------------------------
// The spend appends two commitments; the shield must prove from exactly the
// root they leave behind, or the adapter's second pool call reverts.
const c1 = commitment(planned.outputs[0]!.note);
const c2 = commitment(planned.outputs[1]!.note);
const leaves = pool.commitments.map(hexToField);
const leavesAfter = [...leaves, c1, c2];
const outNote = newNote(10n ** 5n, USDG, trader.mpk);
const at = appendProof(leavesAfter, commitment(outNote));
check(
  "the shield leg opens on the root the spend closes",
  at.oldRoot === computeRoot(leavesAfter),
  fieldToHex(at.oldRoot),
);
check("the output note is the exact amount out", outNote.value === 10n ** 5n && outNote.token === USDG);

// ---- wire parity with the CLI ----------------------------------------------
const submission: TradeSubmission = {
  spend: {
    membershipRoot: fieldToHex(computeRoot(leaves)) as `0x${string}`,
    nullifiers: [fieldToHex(randomField()) as `0x${string}`, fieldToHex(randomField()) as `0x${string}`],
    commitments: [fieldToHex(c1) as `0x${string}`, fieldToHex(c2) as `0x${string}`],
    newRoot: fieldToHex(computeRoot(leavesAfter)) as `0x${string}`,
    token: ETH,
    value: capRelayed,
    fee: FEE,
    recipient: ADAPTER,
    relayer: RELAYER,
  },
  spendCiphertexts: ["0xaa", "0xbb"],
  spendProof: "0xdead",
  tokenOut: USDG,
  amountOut: 10n ** 5n,
  poolFee: 500,
  shieldCommitment: fieldToHex(commitment(outNote)) as `0x${string}`,
  shieldNewRoot: fieldToHex(at.newRoot) as `0x${string}`,
  shieldCiphertext: "0xcc",
  shieldProof: "0xbeef",
};
check(
  "encodeTrade matches the CLI byte for byte",
  JSON.stringify(encodeTrade(submission)) ===
    JSON.stringify(cliEncodeTrade(submission as unknown as CliTradeSubmission)),
);

// ---- the executor's promises, pinned in source ------------------------------
{
  const provider = readFileSync(new URL("../components/ShieldedProvider.tsx", import.meta.url), "utf8");
  const body = provider.slice(provider.indexOf("const tradeExec"));
  check("tradeExec exists", provider.includes("const tradeExec"));
  check('its relayer quote is sized for a trade', /tryQuote\([^;]*"trade",?\s*\)/s.test(body));
  check(
    "relayed keeps the bare quote, self-paid gains headroom",
    /quotedIn \+ \(quote \? 0n : quotedIn \/ 100n\)/.test(body),
  );
  check(
    "the run refuses legs that do not chain",
    /at\.oldRoot[^;]*!==[^;]*spendProof\.spend\.newRoot/s.test(body),
  );
  check(
    "the output note's secrets are stashed before broadcast",
    body.indexOf("stashPendingNote") > 0 && body.indexOf("stashPendingNote") < body.indexOf("simulateTrade("),
  );
  check(
    "the dry-run runs as whoever will submit",
    /simulateTrade\(quote \? quote\.relayer : wc\.account\.address/.test(body),
  );

  const card = readFileSync(new URL("../components/SwapCard.tsx", import.meta.url), "utf8");
  check('the card quotes the relayer with op "trade"', /useRelayQuote\([^)]*"trade"\)/.test(card));
  check("the card estimates self gas from tradeGas", /useSelfGasEstimate\([^)]*tradeGas/.test(card));
  check("shared trade sizes guard the amount", card.includes("tiersFor("));
  check("the swap card is live", !/const LIVE = false/.test(card));
}

// ---- the live venue ---------------------------------------------------------
try {
  const inLeg = venueLeg(mainnet, 0n);
  const outLeg = venueLeg(mainnet, USDG);
  const buy = await quoteExactOutput(mainnet, inLeg, outLeg, 10n ** 5n); // 0.1 USDG out
  check("the venue prices ETH → USDG", buy > 0n, `${buy} wei for 0.1 USDG`);
  const sell = await quoteExactOutput(mainnet, outLeg, inLeg, 10n ** 13n); // 0.00001 ETH out
  check("the venue prices USDG → ETH", sell > 0n, `${sell} USDG units for 0.00001 ETH`);

  // The tier scan: a route pinned to one tier would declare every other
  // pair unpriceable. The property that matters is that scanning never does
  // worse than the pinned tier — whichever pool answers cheapest is a real,
  // executable quote, not a cosmetic one.
  const bestUsdg = await quoteBestExactOutput(mainnet, inLeg, outLeg, 10n ** 5n);
  check(
    "the scan never pays more than the pinned tier",
    bestUsdg.amount <= buy,
    `scan ${bestUsdg.amount} (tier ${bestUsdg.feeTier}) vs pinned ${buy}`,
  );
  const cowl = mainnet.contracts.cowl!;
  const bestCowl = await quoteBestExactOutput(mainnet, inLeg, cowl, 10_000n * 10n ** 18n);
  check(
    "COWL routes through its 1% pool",
    bestCowl.amount > 0n && bestCowl.feeTier === 10000,
    `${bestCowl.amount} wei for 10k COWL, tier ${bestCowl.feeTier}`,
  );
  const payAnchored = await quoteBestExactInput(mainnet, inLeg, cowl, 10n ** 15n);
  check(
    "a pay-side anchor quotes what the input buys",
    payAnchored.amount > 0n && payAnchored.feeTier === 10000,
    `0.001 ETH buys ${payAnchored.amount} COWL units`,
  );

  // Token→token has no direct pool, so the card routes it as two legs
  // through native — both legs must price for the route to exist.
  const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
  const legA = await quoteBestExactInput(mainnet, AAPL, inLeg, 10n ** 16n); // 0.01 AAPL → ETH
  const legB = await quoteBestExactInput(mainnet, inLeg, cowl, legA.amount); // that ETH → COWL
  check(
    "a token→token pair routes through native",
    legA.amount > 0n && legB.amount > 0n,
    `0.01 AAPL → ${legA.amount} wei → ${legB.amount} COWL units`,
  );
} catch (e) {
  check("the venue quoter answers", false, (e as Error).message.split("\n")[0]);
}

// ---- the live relayer -------------------------------------------------------
try {
  const spendQ = await fetchQuote(mainnet.defaultRelay!);
  const tradeQ = await fetchQuote(mainnet.defaultRelay!, undefined, "trade");
  check(
    "a trade fee is sized above a spend fee",
    tradeQ.feeWei > spendQ.feeWei,
    `trade ${tradeQ.feeWei} vs spend ${spendQ.feeWei} wei`,
  );
} catch (e) {
  check("the live relayer quotes a trade", false, (e as Error).message.split("\n")[0]);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
