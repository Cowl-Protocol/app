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
import { applyScan, computeBalance, emptyPool, emptyWallet, planSend } from "../lib/shielded/pool";
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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
