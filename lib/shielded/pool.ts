// Shielded-pool state for the browser — the pure core of cli/src/shielded/pool.ts.
//
// The split is the same as the CLI's:
//   • the POOL is the shared ledger (commitment tree, nullifier set, broadcast
//     ciphertexts), rebuilt from the chain's event log;
//   • a WALLET holds only its owner's discovered notes.
//
// Everything here is a pure function over (pool, wallet, keys). Persistence
// lives in store.ts (localStorage), and the sim-only mutation ops stayed in the
// CLI — the browser only ever plans real spends and follows the chain.
import { formatEther } from "viem";
import { fieldToHex, hexToField, randomField } from "./field";
import { type Note, commitment, nullifier, newNote } from "./note";
import { computeRoot } from "./tree";
import { type NoteCipher, encryptNote, tryDecryptNote, unpackCipher } from "./crypto";
import type { ShieldedKeys, PaymentAddress } from "./keys";
import type { SpendPlan, SpendOutput } from "./prove";

// ---- types ------------------------------------------------------------------

export type Pool = {
  commitments: string[]; // hex, insertion order = leaf index
  nullifiers: string[]; // hex, the spent set
  ciphertexts: (NoteCipher | null)[]; // one slot per commitment
  root: string; // current Merkle root (hex)
  syncedBlock?: string; // cursor for the incremental log replay
};

export type StoredNote = {
  value: string; // hex
  token: string; // hex
  blinding: string; // hex
  leafIndex: number;
  spent: boolean;
};

/**
 * A note whose deposit has broadcast but not yet been filed against a leaf.
 * Written BEFORE the transaction goes out: if the tab dies between the tx
 * landing and local state updating, the blinding survives here — without it
 * the funds behind the commitment would be unspendable forever.
 */
export type PendingNote = { value: string; token: string; blinding: string; commitment: string };

export type Wallet = { notes: StoredNote[]; pending?: PendingNote[] };

export function emptyPool(): Pool {
  return { commitments: [], nullifiers: [], ciphertexts: [], root: fieldToHex(computeRoot([])) };
}
export function emptyWallet(): Wallet {
  return { notes: [] };
}

function toStored(n: Note, leafIndex: number): StoredNote {
  return {
    value: fieldToHex(n.value),
    token: fieldToHex(n.token),
    blinding: fieldToHex(n.blinding),
    leafIndex,
    spent: false,
  };
}

// ---- scan / balance ---------------------------------------------------------

/** Discover notes paid to me and refresh which of my notes are spent. */
export function applyScan(pool: Pool, wallet: Wallet, keys: ShieldedKeys): { discovered: number } {
  // Adopt pending deposits whose commitment has appeared in the log.
  if (wallet.pending?.length) {
    wallet.pending = wallet.pending.filter((pn) => {
      const idx = pool.commitments.indexOf(pn.commitment);
      if (idx < 0) return true; // not landed yet — keep waiting
      if (!wallet.notes.some((n) => n.leafIndex === idx)) {
        wallet.notes.push({ value: pn.value, token: pn.token, blinding: pn.blinding, leafIndex: idx, spent: false });
      }
      return false;
    });
  }

  const known = new Set(wallet.notes.map((n) => n.leafIndex));
  const nulls = new Set(pool.nullifiers);
  let discovered = 0;

  for (let i = 0; i < pool.ciphertexts.length; i++) {
    if (known.has(i)) continue;
    const cipher = pool.ciphertexts[i];
    if (!cipher) continue;
    const dec = tryDecryptNote(cipher, keys.viewPriv);
    if (!dec) continue;
    const note: Note = { value: dec.value, token: dec.token, mpk: keys.mpk, blinding: dec.blinding };
    if (fieldToHex(commitment(note)) !== pool.commitments[i]) continue; // not really ours
    wallet.notes.push(toStored(note, i));
    known.add(i);
    discovered++;
  }

  // Drop notes the pool no longer vouches for.
  wallet.notes = wallet.notes.filter((n) => {
    const at = pool.commitments[n.leafIndex];
    if (!at) return false;
    const note: Note = {
      value: hexToField(n.value),
      token: hexToField(n.token),
      mpk: keys.mpk,
      blinding: hexToField(n.blinding),
    };
    return fieldToHex(commitment(note)) === at;
  });

  // `spent` is a cache of the chain's nullifier set, recomputed both directions.
  for (const n of wallet.notes) {
    n.spent = nulls.has(fieldToHex(nullifier(keys.nk, n.leafIndex)));
  }
  return { discovered };
}

export type Balance = { token: bigint; amount: bigint; notes: number }[];

/** Shielded portfolio: unspent value grouped by token. */
export function computeBalance(wallet: Wallet): Balance {
  const by = new Map<string, { amount: bigint; notes: number }>();
  for (const n of wallet.notes) {
    if (n.spent) continue;
    if (hexToField(n.value) === 0n) continue; // zero-value fillers hold nothing
    const cur = by.get(n.token) ?? { amount: 0n, notes: 0 };
    cur.amount += hexToField(n.value);
    cur.notes++;
    by.set(n.token, cur);
  }
  return [...by.entries()].map(([token, v]) => ({ token: hexToField(token), amount: v.amount, notes: v.notes }));
}

// ---- real-spend planning (non-mutating) -------------------------------------

export type PlannedSpend = {
  /** Feed straight to proveTransfer. */
  plan: SpendPlan;
  /** The two outputs to encrypt and publish, in the order the proof appends them. */
  outputs: { note: Note; viewPubHex: string }[];
  /** Leaf indices of the real inputs being spent — for display. */
  inputLeaves: number[];
};

/** Pick one or two unspent notes of `token` covering `need`; a join-split takes at most two. */
export function selectUpTo2(wallet: Wallet, token: bigint, need: bigint): StoredNote[] {
  const avail = wallet.notes
    .filter((n) => !n.spent && hexToField(n.token) === token)
    .sort((a, b) => (hexToField(a.value) < hexToField(b.value) ? -1 : 1));
  const single = avail.find((n) => hexToField(n.value) >= need);
  if (single) return [single];
  const two = avail.slice(-2);
  const twoTotal = two.reduce((s, n) => s + hexToField(n.value), 0n);
  if (two.length === 2 && twoTotal >= need) return two;
  const have = avail.reduce((s, n) => s + hexToField(n.value), 0n);
  if (have < need) {
    throw new Error(`Insufficient shielded balance: need ${formatEther(need)}, have ${formatEther(have)}.`);
  }
  throw new Error(
    `Shielded balance is too fragmented: no two notes cover ${formatEther(need)}. Consolidate first.`,
  );
}

const outParts = (n: Note): SpendOutput => ({ mpk: n.mpk, value: n.value, blinding: n.blinding });

function planInputs(inputs: StoredNote[]): SpendPlan["inputs"] {
  return inputs.map((n) => ({ value: hexToField(n.value), blinding: hexToField(n.blinding), leafIndex: n.leafIndex }));
}

/**
 * Plan an unshield: `value` leaves to `payout` (your public address as a field),
 * change stays private. A relayed spend adds `fee` for `relayer`, bound into the
 * proof; self-submitted spends carry both as zero.
 */
/**
 * Merge the two smallest notes of `token` into one, back to yourself.
 *
 * A join-split reads two notes at most, so a balance scattered across many
 * small ones can hold far more than any single spend can move. Each round
 * turns two notes into one, which means n notes settle in n minus two rounds
 * and the ceiling climbs every time.
 *
 * Nothing about it is special on chain: two nullifiers, two commitments, no
 * public value, exactly like a payment to yourself.
 */
export function planConsolidate(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  token: bigint,
  chainId: bigint,
): PlannedSpend {
  const avail = wallet.notes
    .filter((n) => !n.spent && hexToField(n.token) === token && hexToField(n.value) > 0n)
    .sort((a, b) => (hexToField(a.value) < hexToField(b.value) ? 1 : -1));
  if (avail.length < 3) {
    throw new Error("Nothing to merge, two notes or fewer already spend together.");
  }
  // The two LARGEST, not the two smallest.
  //
  // What limits a spend is the sum of the top two notes, so that is the number
  // a merge has to move. Combining the two smallest builds a pile from the
  // bottom and can leave the top untouched for a whole round: on a book of
  // seven 100k notes and one 50k, reaching 500k took five rounds and the fourth
  // raised the ceiling by nothing at all. Taking the top two lifts it every
  // time, and the same book gets there in three.
  const [a, b] = [avail[0]!, avail[1]!];
  const total = hexToField(a.value) + hexToField(b.value);
  const out0: Note = { value: total, token, mpk: keys.mpk, blinding: randomField() };
  const out1: Note = { value: 0n, token, mpk: keys.mpk, blinding: randomField() };
  return {
    plan: {
      sk: keys.sk,
      nk: keys.nk,
      token,
      inputs: planInputs([a, b]),
      outputs: [outParts(out0), outParts(out1)],
      leaves: pool.commitments.map(hexToField),
      // A merge never has a public leg, so this field is free — and naming the
      // asset here would say which token a book is fragmented in.
      publicToken: 0n,
      publicValue: 0n,
      fee: 0n,
      recipient: 0n,
      relayer: 0n,
      chainId,
    },
    outputs: [
      { note: out0, viewPubHex: keys.viewPubHex },
      { note: out1, viewPubHex: keys.viewPubHex },
    ],
    inputLeaves: [a.leafIndex, b.leafIndex],
  };
}

/**
 * How many merges it takes before one spend can move `target` of `token`.
 *
 * Each round retires the two smallest notes and mints their sum, so the two
 * largest grow every time. Counted here rather than guessed, because "merge a
 * few times and try again" is not an instruction anyone can follow.
 */
export function mergesNeeded(wallet: Wallet, token: bigint, target: bigint): number {
  let values = wallet.notes
    .filter((n) => !n.spent && hexToField(n.token) === token && hexToField(n.value) > 0n)
    .map((n) => hexToField(n.value))
    .sort((a, b) => (a < b ? -1 : 1));

  const top2 = (v: bigint[]) => v.slice(-2).reduce((s, x) => s + x, 0n);
  let rounds = 0;
  // Counted the way planConsolidate merges, or the number on screen is a
  // promise about a run that behaves differently.
  while (top2(values) < target && values.length >= 3) {
    const merged = values[values.length - 1]! + values[values.length - 2]!;
    values = [...values.slice(0, values.length - 2), merged].sort((a, b) => (a < b ? -1 : 1));
    rounds++;
  }
  // Unreachable even after merging everything: the book simply holds less.
  return top2(values) >= target ? rounds : -1;
}

export function planUnshield(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  value: bigint,
  token: bigint,
  payout: bigint,
  chainId: bigint,
  fee: bigint = 0n,
  relayer: bigint = 0n,
): PlannedSpend {
  const inputs = selectUpTo2(wallet, token, value + fee);
  const total = inputs.reduce((s, n) => s + hexToField(n.value), 0n);
  const out0: Note = { value: total - value - fee, token, mpk: keys.mpk, blinding: randomField() };
  const out1: Note = { value: 0n, token, mpk: keys.mpk, blinding: randomField() };
  return {
    plan: {
      sk: keys.sk,
      nk: keys.nk,
      token,
      inputs: planInputs(inputs),
      outputs: [outParts(out0), outParts(out1)],
      leaves: pool.commitments.map(hexToField),
      publicToken: token,
      publicValue: value,
      fee,
      recipient: payout,
      relayer,
      chainId,
    },
    outputs: [
      { note: out0, viewPubHex: keys.viewPubHex },
      { note: out1, viewPubHex: keys.viewPubHex },
    ],
    inputLeaves: inputs.map((n) => n.leafIndex),
  };
}

/**
 * Plan a private send: `value` to the recipient, change back to you, no public leg.
 *
 * The circuit ties `public_token` to the notes' asset only when something
 * actually leaves — `(public_value + fee) * (public_token - token) == 0` — so a
 * send that pays no relayer is free to leave it at zero and say nothing about
 * which asset moved. Filling it in anyway is a leak nobody is charging for: the
 * value stays hidden, the parties stay hidden, and then the calldata names the
 * token. A relayer fee forfeits that, because the fee is paid out of these same
 * notes and the constraint above then pins the field to the real asset.
 */
export function planSend(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  recipient: PaymentAddress,
  value: bigint,
  token: bigint,
  chainId: bigint,
  fee: bigint = 0n,
  relayer: bigint = 0n,
): PlannedSpend {
  const inputs = selectUpTo2(wallet, token, value + fee);
  const total = inputs.reduce((s, n) => s + hexToField(n.value), 0n);
  const out0: Note = { value, token, mpk: recipient.mpk, blinding: randomField() };
  const out1: Note = { value: total - value - fee, token, mpk: keys.mpk, blinding: randomField() };
  return {
    plan: {
      sk: keys.sk,
      nk: keys.nk,
      token,
      inputs: planInputs(inputs),
      outputs: [outParts(out0), outParts(out1)],
      leaves: pool.commitments.map(hexToField),
      // Zero unless a fee forces it — see above.
      publicToken: fee === 0n ? 0n : token,
      publicValue: 0n,
      fee,
      recipient: 0n,
      relayer,
      chainId,
    },
    outputs: [
      { note: out0, viewPubHex: recipient.viewPubHex },
      { note: out1, viewPubHex: keys.viewPubHex },
    ],
    inputLeaves: inputs.map((n) => n.leafIndex),
  };
}

// ---- chain alignment --------------------------------------------------------

/** The local log and the chain's log disagree — only a full replay can reconcile. */
export class ChainDrift extends Error {}

/**
 * Append newly seen on-chain leaves to the local log. Throws ChainDrift when the
 * logs disagree and the caller falls back to a full replay.
 */
export function applyChainLeaves(
  pool: Pool,
  leaves: { index: number; commitment: string; cipher?: string }[],
  nullifiers: string[],
  totalLeaves: number,
  chainRoot?: string,
): number {
  let appended = 0;
  for (const leaf of [...leaves].sort((a, b) => a.index - b.index)) {
    if (leaf.index < pool.commitments.length) {
      if (pool.commitments[leaf.index] !== leaf.commitment) {
        throw new ChainDrift(`Local leaf #${leaf.index} does not match the chain.`);
      }
      continue;
    }
    if (leaf.index > pool.commitments.length) {
      throw new ChainDrift(`Leaf #${leaf.index} arrived before #${pool.commitments.length}.`);
    }
    pool.commitments.push(leaf.commitment);
    pool.ciphertexts.push(leaf.cipher ? unpackCipher(leaf.cipher) : null);
    appended++;
  }

  const knownNulls = new Set(pool.nullifiers);
  for (const nf of nullifiers) {
    if (!knownNulls.has(nf)) {
      pool.nullifiers.push(nf);
      knownNulls.add(nf);
    }
  }
  if (pool.commitments.length !== totalLeaves) {
    throw new ChainDrift(`Pool has ${totalLeaves} leaves on chain but ${pool.commitments.length} locally.`);
  }
  if (appended > 0) pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
  // The count says how many leaves; the root says they are the right leaves in
  // the right order. A corrupted log of the right length is caught here only.
  if (chainRoot !== undefined && pool.root !== chainRoot) {
    throw new ChainDrift(`Local root ${pool.root} does not match the chain's ${chainRoot}.`);
  }
  return appended;
}

/**
 * Replace the local log with the chain's wholesale — the ChainDrift recovery
 * path. Ciphertexts carry across by commitment value, never by position.
 */
export function alignPoolToChain(
  pool: Pool,
  leaves: { index: number; commitment: string; cipher?: string }[],
  nullifiers: string[],
): void {
  const localCipher = new Map<string, NoteCipher>();
  pool.commitments.forEach((c, i) => {
    const cipher = pool.ciphertexts[i];
    if (cipher) localCipher.set(c, cipher);
  });
  const commitments: string[] = [];
  const ciphertexts: (NoteCipher | null)[] = [];
  for (const leaf of [...leaves].sort((a, b) => a.index - b.index)) {
    commitments[leaf.index] = leaf.commitment;
    ciphertexts[leaf.index] = leaf.cipher ? unpackCipher(leaf.cipher) : (localCipher.get(leaf.commitment) ?? null);
  }
  pool.commitments = commitments;
  pool.ciphertexts = ciphertexts;
  pool.nullifiers = [...new Set(nullifiers)];
  pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
}

// ---- deposit bookkeeping ----------------------------------------------------

/** Stash a note's secrets before its deposit broadcasts — see PendingNote. */
export function stashPendingNote(wallet: Wallet, note: Note): void {
  const c = fieldToHex(commitment(note));
  wallet.pending = wallet.pending ?? [];
  if (!wallet.pending.some((pn) => pn.commitment === c)) {
    wallet.pending.push({
      value: fieldToHex(note.value),
      token: fieldToHex(note.token),
      blinding: fieldToHex(note.blinding),
      commitment: c,
    });
  }
}

/**
 * File a note we just deposited at the leaf index the CONTRACT assigned, after a
 * sync has brought the local log up to the chain.
 */
export function recordMyNote(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  note: Note,
  leafIndex: number,
): void {
  const c = fieldToHex(commitment(note));
  if (pool.commitments[leafIndex] !== c) {
    throw new Error(
      `Chain leaf #${leafIndex} holds ${pool.commitments[leafIndex] ?? "nothing"}, not the commitment we deposited (${c}).`,
    );
  }
  pool.ciphertexts[leafIndex] = encryptNote(note, keys.viewPubHex);
  if (!wallet.notes.some((n) => n.leafIndex === leafIndex)) wallet.notes.push(toStored(note, leafIndex));
  if (wallet.pending) wallet.pending = wallet.pending.filter((pn) => pn.commitment !== c);
}

export { newNote };
