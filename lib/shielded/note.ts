// A shielded note is a private UTXO: a hidden amount of one token owned by one
// master public key. Its commitment goes into the on-chain Merkle tree; spending
// it later reveals only a nullifier, never the note itself.
// Browser port of cli/src/shielded/note.ts, minus the local-sim symbol table —
// in the app a token is the native coin (0) or an ERC-20 address as a field.
import { poseidon, randomField, DOMAIN_NULLIFIER } from "./field";

export type Note = {
  value: bigint; // base units (wei / token smallest unit)
  token: bigint; // 0 = native coin, else the ERC-20 address as a field element
  mpk: bigint; // owner master public key
  blinding: bigint; // per-note randomness
};

export function newNote(value: bigint, token: bigint, mpk: bigint): Note {
  return { value, token, mpk, blinding: randomField() };
}

/** commitment = Poseidon(mpk, token, value, blinding) */
export function commitment(n: Note): bigint {
  return poseidon([n.mpk, n.token, n.value, n.blinding]);
}

/** nullifier = Poseidon(DOMAIN_NULLIFIER, nullifyingKey, leafIndex) — unlinkable to the commitment. */
export function nullifier(nk: bigint, leafIndex: number | bigint): bigint {
  return poseidon([DOMAIN_NULLIFIER, nk, BigInt(leafIndex)]);
}

/** An EVM address as the field element the pool's token id uses. */
export function addressToField(address: `0x${string}`): bigint {
  return BigInt(address);
}
