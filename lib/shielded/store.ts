"use client";

// Persistence for the browser's shielded state, the counterpart of the CLI's
// ~/.cowl files. The pool log is public data (rebuilt from chain events) and
// keyed per network. The wallet's decrypted notes are keyed per network AND per
// account (mpk prefix), so two wallets in one browser never share a book.
//
// What is deliberately NOT stored: sk, nk, viewPriv. Keys live in memory for
// the session and re-derive from the unlock signature. The cached notes expose
// amounts and blindings if the storage is read — a privacy exposure, not a
// spending one; spending needs the signature-derived spending key.
import { fieldToHex } from "./field";
import type { ShieldedKeys } from "./keys";
import { emptyPool, emptyWallet, type Pool, type Wallet } from "./pool";

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — state survives in memory for the session */
  }
}

const poolKey = (net: string) => `cowl.pool.${net}`;
const walletKey = (net: string, keys: ShieldedKeys) =>
  `cowl.notes.${net}.${fieldToHex(keys.mpk).slice(2, 18)}`;

export function loadPool(net: string): Pool {
  return read<Pool>(poolKey(net)) ?? emptyPool();
}

export function savePool(net: string, pool: Pool): void {
  write(poolKey(net), pool);
}

export function loadWallet(net: string, keys: ShieldedKeys): Wallet {
  return read<Wallet>(walletKey(net, keys)) ?? emptyWallet();
}

export function saveWallet(net: string, keys: ShieldedKeys, wallet: Wallet): void {
  write(walletKey(net, keys), wallet);
}
