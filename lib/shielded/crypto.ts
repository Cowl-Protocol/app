// Encrypt a note to a recipient's secp256k1 view key so only they can find it.
// Browser port of cli/src/shielded/crypto.ts: AES-256-GCM comes from
// @noble/ciphers instead of node:crypto. AES-GCM is deterministic in
// (key, iv, plaintext), so both implementations produce byte-identical
// ciphertexts and read each other's freely.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes, randomBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes";
import type { Note } from "./note";

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

export type NoteCipher = {
  eph: string; // ephemeral compressed pubkey, no 0x
  tag: string; // AES-GCM auth tag (hex)
  iv: string; // AES-GCM iv (hex)
  ct: string; // ciphertext (hex)
  vt: string; // 1-byte view tag (hex) for fast scan filtering
};

// Every field packs to a fixed 32 bytes so every note encrypts to the same 96 —
// an unpadded payload would leak a note's magnitude through its length.
const FIELD_BYTES = 32;
const PAYLOAD_BYTES = 3 * FIELD_BYTES; // value, token, blinding
const TAG_BYTES = 16;

function packField(v: bigint): Uint8Array {
  const hex = v.toString(16);
  if (hex.length > FIELD_BYTES * 2) throw new Error(`Field element too wide to pack: 0x${hex}`);
  return hexToBytes(hex.padStart(FIELD_BYTES * 2, "0"));
}

function unpackField(b: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(b));
}

function sharedKey(point: InstanceType<typeof Point>): { key: Uint8Array; viewTag: string } {
  const h = keccak_256(point.toRawBytes(true));
  return { key: h, viewTag: bytesToHex(h.slice(0, 1)) };
}

/** Encrypt a note to `viewPubHex` (recipient's compressed secp256k1 view key). */
export function encryptNote(note: Note, viewPubHex: string): NoteCipher {
  const viewPub = Point.fromHex(viewPubHex.replace(/^0x/, ""));
  let ephPriv = BigInt("0x" + bytesToHex(secp256k1.utils.randomPrivateKey())) % N;
  if (ephPriv === 0n) ephPriv = 1n;
  const ephPub = Point.BASE.multiply(ephPriv);
  const { key, viewTag } = sharedKey(viewPub.multiply(ephPriv));

  const payload = concatBytes(packField(note.value), packField(note.token), packField(note.blinding));
  const iv = randomBytes(12);
  // noble's gcm returns ciphertext with the 16-byte auth tag appended.
  const sealed = gcm(key, iv).encrypt(payload);
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  return {
    eph: bytesToHex(ephPub.toRawBytes(true)),
    tag: bytesToHex(tag),
    iv: bytesToHex(iv),
    ct: bytesToHex(ct),
    vt: viewTag,
  };
}

/** Try to decrypt with `viewPriv`. Returns note fields, or null if not ours. */
export function tryDecryptNote(
  c: NoteCipher,
  viewPriv: bigint,
): { value: bigint; token: bigint; blinding: bigint } | null {
  const ephPub = Point.fromHex(c.eph);
  const { key, viewTag } = sharedKey(ephPub.multiply(viewPriv));
  if (viewTag !== c.vt) return null; // fast reject
  try {
    const sealed = concatBytes(hexToBytes(c.ct), hexToBytes(c.tag));
    const plain = gcm(key, hexToBytes(c.iv)).decrypt(sealed);
    if (plain.length !== PAYLOAD_BYTES) return null;
    return {
      value: unpackField(plain.subarray(0, FIELD_BYTES)),
      token: unpackField(plain.subarray(FIELD_BYTES, 2 * FIELD_BYTES)),
      blinding: unpackField(plain.subarray(2 * FIELD_BYTES, PAYLOAD_BYTES)),
    };
  } catch {
    return null;
  }
}

// The note ciphertext, packed for the chain. ShieldedPool emits a NoteCipher of a
// fixed 158 bytes, laid out eph(33) + iv(12) + ct(96) + tag(16) + viewTag(1).
export const NOTE_CIPHER_BYTES = 158;

export function packCipher(c: NoteCipher): `0x${string}` {
  const blob = concatBytes(
    hexToBytes(c.eph), // 33  ephemeral compressed pubkey
    hexToBytes(c.iv), //  12  AES-GCM iv
    hexToBytes(c.ct), //  96  ciphertext (== payload length)
    hexToBytes(c.tag), // 16  AES-GCM auth tag
    hexToBytes(c.vt), //   1  view tag
  );
  if (blob.length !== NOTE_CIPHER_BYTES) {
    throw new Error(`Packed note cipher is ${blob.length} bytes, expected ${NOTE_CIPHER_BYTES}.`);
  }
  return `0x${bytesToHex(blob)}`;
}

export function unpackCipher(hex: string): NoteCipher {
  const b = hexToBytes(hex.replace(/^0x/, ""));
  if (b.length !== NOTE_CIPHER_BYTES) {
    throw new Error(`On-chain note cipher is ${b.length} bytes, expected ${NOTE_CIPHER_BYTES}.`);
  }
  return {
    eph: bytesToHex(b.subarray(0, 33)),
    iv: bytesToHex(b.subarray(33, 45)),
    ct: bytesToHex(b.subarray(45, 141)),
    tag: bytesToHex(b.subarray(141, 157)),
    vt: bytesToHex(b.subarray(157, 158)),
  };
}

export { bytesToHex, hexToBytes };
