// BN254 scalar field (Fr) helpers — browser port of cli/src/shielded/field.ts.
// Every value that flows through a commitment, nullifier, or Merkle node lives
// in this field, so this side computes the exact same numbers the Noir circuit
// proves over. The only departure from the CLI file is the randomness source:
// noble's crypto-backed randomBytes instead of node:crypto, same distribution.
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { poseidon2Hash } from "@zkpassport/poseidon2";

/** BN254 scalar field modulus. */
export const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Domain tags for the two two-field hashes — mpk-derivation and nullification —
 * that would otherwise share the Merkle-node shape. ASCII "cowl:mpk" and
 * "cowl:nul"; mirrored in circuits/notes/src/lib.nr.
 */
export const DOMAIN_MPK = 0x636f776c3a6d706bn;
export const DOMAIN_NULLIFIER = 0x636f776c3a6e756cn;

export function mod(x: bigint): bigint {
  const r = x % FR;
  return r < 0n ? r + FR : r;
}

/** Reduce arbitrary bytes to a field element. */
export function bytesToField(b: Uint8Array): bigint {
  return mod(BigInt("0x" + bytesToHex(b)));
}

/** Keccak of a label into the field — deterministic key derivation. */
export function hashToField(...parts: Uint8Array[]): bigint {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return bytesToField(keccak_256(buf));
}

/** A uniform random field element (32 bytes reduced mod Fr). */
export function randomField(): bigint {
  return bytesToField(randomBytes(32));
}

/** Poseidon2 over 1–4 field inputs (variable-length sponge, matches Noir). */
export function poseidon(inputs: bigint[]): bigint {
  if (inputs.length < 1 || inputs.length > 4) {
    throw new Error(`poseidon arity ${inputs.length} unsupported`);
  }
  return poseidon2Hash(inputs);
}

/** 0x-prefixed, zero-padded 32-byte hex of a field element. */
export function fieldToHex(x: bigint): string {
  return "0x" + x.toString(16).padStart(64, "0");
}

export function hexToField(hex: string): bigint {
  return mod(BigInt(hex.startsWith("0x") ? hex : "0x" + hex));
}
