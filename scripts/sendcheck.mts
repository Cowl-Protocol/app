// Send-check: a private payment end to end, without money. Run with:
//   npx tsx scripts/sendcheck.mts
//
// Two shielded accounts are derived, a note is planted for the sender, and the
// send is planned, proved and then replayed into the pool the way the chain
// would publish it. What it asserts is everything the browser cannot show you:
//
//   1. value conservation        in == out + change, to the wei
//   2. output ownership          payment carries the recipient's mpk, change yours
//   3. cipher separation         each side reads its own note and only its own
//   4. a real transfer proof     the ported witness clears bb with 14 public inputs
//   5. the recipient's view      after the spend lands, their scan finds the payment
//   6. the sender's view         the input reads spent, the change reads theirs
//
// No RPC and no wallet: the pool here is synthetic, so this runs anywhere and
// says nothing about the live chain (crosscheck.mts covers that).
import { fieldToHex, hexToField, randomField } from "../lib/shielded/field";
import { commitment, nullifier, type Note } from "../lib/shielded/note";
import { encryptNote, tryDecryptNote } from "../lib/shielded/crypto";
import { decodePaymentAddress, deriveShieldedKeysFromSignature, isPaymentAddress } from "../lib/shielded/keys";
import { computeRoot } from "../lib/shielded/tree";
import {
  applyScan,
  computeBalance,
  emptyPool,
  emptyWallet,
  planConsolidate,
  planSend,
  planUnshield,
} from "../lib/shielded/pool";
import { proveTransfer } from "../lib/shielded/prove";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const CHAIN_ID = 4663n;
const ETH = 0n;
const HELD = 5n * 10n ** 16n; // 0.05
const PAY = 2n * 10n ** 16n; // 0.02

const sender = deriveShieldedKeysFromSignature("0x" + "a7".repeat(65));
const recipient = deriveShieldedKeysFromSignature("0x" + "5c".repeat(65));
check("two distinct shielded accounts", sender.mpk !== recipient.mpk);

// ---- the address survives the trip, and a typo does not ---------------------
{
  const addr = recipient.paymentAddress;
  const decoded = decodePaymentAddress(addr);
  check(
    "payment address roundtrip",
    decoded.mpk === recipient.mpk && decoded.viewPubHex === recipient.viewPubHex,
  );
  // Flip one character mid-address: the bech32m checksum must catch it, the
  // exact failure the old hex format paid straight into unspendable keys.
  const i = Math.floor(addr.length / 2);
  const flipped = addr.slice(0, i) + (addr[i] === "q" ? "p" : "q") + addr.slice(i + 1);
  check("one mistyped character is rejected", !isPaymentAddress(flipped));
  check("truncated address is rejected", !isPaymentAddress(addr.slice(0, -1)));
}

// ---- a pool holding one note of the sender's, among strangers ---------------
const pool = emptyPool();
const strangers = [randomField(), randomField()];
const held: Note = { value: HELD, token: ETH, mpk: sender.mpk, blinding: randomField() };
pool.commitments.push(fieldToHex(strangers[0]!), fieldToHex(commitment(held)), fieldToHex(strangers[1]!));
pool.ciphertexts.push(null, encryptNote(held, sender.viewPubHex), null);
pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));

const senderWallet = emptyWallet();
applyScan(pool, senderWallet, sender);
check(
  "sender's book reads the planted note",
  computeBalance(senderWallet)[0]?.amount === HELD,
  `${computeBalance(senderWallet)[0]?.amount} wei`,
);

// ---- plan the payment -------------------------------------------------------
const planned = planSend(
  pool,
  senderWallet,
  sender,
  decodePaymentAddress(recipient.paymentAddress),
  PAY,
  ETH,
  CHAIN_ID,
);
const [payment, change] = planned.outputs;

check(
  "value conserved across the join-split",
  payment!.note.value + change!.note.value === HELD && planned.plan.publicValue === 0n && planned.plan.fee === 0n,
);
check(
  "payment is owned by the recipient, change by the sender",
  payment!.note.mpk === recipient.mpk && change!.note.mpk === sender.mpk,
);
check(
  "no public leg on a private send",
  planned.plan.recipient === 0n && planned.plan.relayer === 0n && planned.plan.publicValue === 0n,
);

// ---- ciphertexts separate the two sides ------------------------------------
const payCipher = encryptNote(payment!.note, payment!.viewPubHex);
const changeCipher = encryptNote(change!.note, change!.viewPubHex);
const recipientReads = tryDecryptNote(payCipher, recipient.viewPriv);
const senderReads = tryDecryptNote(changeCipher, sender.viewPriv);
check("recipient opens the payment", recipientReads?.value === PAY && recipientReads?.token === ETH);
check("sender opens the change", senderReads?.value === HELD - PAY);
check(
  "neither side opens the other's note",
  !tryDecryptNote(payCipher, sender.viewPriv) && !tryDecryptNote(changeCipher, recipient.viewPriv),
);

// ---- the proof the chain would verify --------------------------------------
const t0 = Date.now();
const proof = await proveTransfer(planned.plan, { threads: 4 });
check(
  "transfer proof generated (evm target)",
  proof.publicInputs.length === 14 && proof.proof.length > 2,
  `${(proof.proof.length - 2) / 2} bytes in ${Date.now() - t0}ms`,
);
check(
  "proof commits to the planned outputs",
  proof.spend.commitments[0] === fieldToHex(commitment({ ...payment!.note, token: ETH })) &&
    proof.spend.commitments[1] === fieldToHex(commitment({ ...change!.note, token: ETH })),
);
check("proof carries no public value", proof.spend.value === 0n && proof.spend.fee === 0n);

// ---- publish it the way the pool does, then read both books ----------------
pool.commitments.push(proof.spend.commitments[0], proof.spend.commitments[1]);
pool.ciphertexts.push(payCipher, changeCipher);
pool.nullifiers.push(...planned.inputLeaves.map((i) => fieldToHex(nullifier(sender.nk, i))));
pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
check("published root matches the proof's new root", pool.root === proof.spend.newRoot);

const recipientWallet = emptyWallet();
const found = applyScan(pool, recipientWallet, recipient);
check(
  "recipient discovers the payment by scanning alone",
  found.discovered === 1 && computeBalance(recipientWallet)[0]?.amount === PAY,
);

applyScan(pool, senderWallet, sender);
const senderBal = computeBalance(senderWallet);
check(
  "sender's book drops the spent note and keeps the change",
  senderBal.length === 1 && senderBal[0]!.amount === HELD - PAY,
  `${senderBal[0]?.amount} wei left`,
);
check(
  "the spent note reads spent",
  senderWallet.notes.filter((n) => !n.spent).every((n) => hexToField(n.value) === HELD - PAY),
);

// ---- the asset stays unnamed ------------------------------------------------
// Everything above moves ETH, whose token field is 0 no matter what the client
// does — which is why none of it could tell a zeroed field from a filled one.
// It was filled. Nine pure sends went out on mainnet each stating in calldata
// that COWL had moved: amount hidden, parties hidden, asset in the clear.
//
// The circuit ties that field to the notes' asset only when something leaves —
// (public_value + fee) * (public_token - token) == 0 — so a send paying no
// relayer is free to leave it at zero. Pinned in Noir by
// send_need_not_name_its_asset; this is the client half of the same claim, and
// it needs a real ERC-20 to mean anything.
{
  const COWL = BigInt("0xfc7cb8a3df69c0f658ac5fb1e31de1843e04e38f");
  const HOLD = 100n * 10n ** 18n;

  const p = emptyPool();
  const notes: Note[] = [
    { value: HOLD, token: COWL, mpk: sender.mpk, blinding: randomField() },
    { value: HOLD, token: COWL, mpk: sender.mpk, blinding: randomField() },
    { value: HOLD, token: COWL, mpk: sender.mpk, blinding: randomField() },
  ];
  for (const n of notes) {
    p.commitments.push(fieldToHex(commitment(n)));
    p.ciphertexts.push(encryptNote(n, sender.viewPubHex));
  }
  p.root = fieldToHex(computeRoot(p.commitments.map(hexToField)));
  const book = emptyWallet();
  applyScan(p, book, sender);

  const to = decodePaymentAddress(recipient.paymentAddress);
  const free = planSend(p, book, sender, to, 10n * 10n ** 18n, COWL, CHAIN_ID);
  check("a send paying no fee names no asset", free.plan.publicToken === 0n, `got ${free.plan.publicToken}`);
  // The note the recipient receives must still hold the real token, or they
  // could never spend it. What is hidden is the calldata, not the note.
  check("the recipient is still paid in the real asset", free.outputs[0]!.note.token === COWL);
  check("and the notes behind it are the real asset", free.plan.token === COWL);

  // Witness solving is not proof: what the pool verifies is a bb evm-target
  // proof against 14 public inputs, and input 8 is this field. Prove it for
  // real, so the zeroed send is known to clear the deployed verifier rather
  // than merely to satisfy the constraint on paper.
  const zp = await proveTransfer(free.plan, { threads: 4 });
  check(
    "the zeroed send still proves",
    zp.publicInputs.length === 14 && zp.spend.token === 0n,
    `public input 8 = ${zp.publicInputs[8]}`,
  );
  check("and the asset never enters the calldata", zp.spend.token === 0n && zp.spend.value === 0n);

  const merged = planConsolidate(p, book, sender, COWL, CHAIN_ID);
  check("a merge names no asset either", merged.plan.publicToken === 0n, `got ${merged.plan.publicToken}`);

  // Not a regression — the constraint above forbids hiding the asset once a fee
  // leaves, so a relayed send has to name it or build a proof that cannot
  // verify. This is what gasless costs, stated rather than discovered.
  const FEE = 10n ** 16n;
  const paid = planSend(p, book, sender, to, 10n * 10n ** 18n, COWL, CHAIN_ID, FEE, 0xbeefn);
  check("a relayed send must name its asset", paid.plan.publicToken === COWL, `got ${paid.plan.publicToken}`);
  check("the fee leaves the pool in the open", paid.plan.fee === FEE);
  check("the payment is untouched by the fee", paid.outputs[0]!.note.value === 10n * 10n ** 18n);
  // One note covers 10.01, so the join-split reads one and the change is what
  // is left of it — the fee comes out of the sender's side, never the payment.
  check(
    "the sender's change absorbs it",
    paid.outputs[1]!.note.value === HOLD - 10n * 10n ** 18n - FEE,
    `${paid.outputs[1]!.note.value}`,
  );

  // A withdrawal has no such choice: value genuinely leaves, and the turnstile
  // meters pooledValue[token], which it cannot do against a zero.
  const exit = planUnshield(p, book, sender, 10n * 10n ** 18n, COWL, 0xbeefn, CHAIN_ID);
  check("a withdrawal always names its asset", exit.plan.publicToken === COWL, `got ${exit.plan.publicToken}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
