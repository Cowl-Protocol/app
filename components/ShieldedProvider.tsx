"use client";

// The shielded account, as React context.
//
// Unlocking asks the connected wallet for one deterministic signature over a
// fixed domain message and derives the shielded keys from it, in memory only —
// nothing secret ever persists. Once unlocked the provider syncs the pool's
// event log, scans it with the view key, and exposes balances plus the two
// real executors: shield (prove, then the wallet pays the deposit in) and
// unshield (prove the join-split, submit through the wallet, value comes out).
//
// Executors run one boundary part at a time: sync, prove against the current
// root, confirm in the wallet, wait for the receipt, record. A revert from a
// root that moved mid-flight (someone else deposited first) resyncs and
// reproves the same part instead of failing the run.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAccount, useSignMessage, useWalletClient } from "wagmi";
import { activeNetwork } from "@/lib/networks";
import { deriveShieldedKeysFromSignature, SHIELDED_SIGN_MESSAGE, type ShieldedKeys } from "@/lib/shielded/keys";
import { commitment, newNote } from "@/lib/shielded/note";
import { encryptNote, packCipher } from "@/lib/shielded/crypto";
import { fieldToHex, hexToField } from "@/lib/shielded/field";
import { appendProof } from "@/lib/shielded/tree";
import {
  applyScan,
  computeBalance,
  planUnshield,
  recordMyNote,
  stashPendingNote,
  type Balance,
} from "@/lib/shielded/pool";
import { loadPool, loadWallet, savePool, saveWallet } from "@/lib/shielded/store";
import { syncShieldedPool } from "@/lib/shielded/sync";
import { approvePool, simulateSpend, submitShield, submitSpend } from "@/lib/shielded/contract";
import { proveShieldOffThread, proveTransferOffThread } from "@/lib/shielded/prover";

const net = activeNetwork();

export type ShieldedStatus = "locked" | "unlocking" | "ready";

export type OpStep = "sync" | "prove" | "confirm" | "mined";

export type OpProgress = {
  op: "shield" | "unshield";
  symbol: string;
  decimals: number;
  parts: bigint[];
  current: number;
  step: OpStep;
  txs: { hash: string; part: number }[];
  done: boolean;
  error?: string;
};

type ShieldedContextValue = {
  status: ShieldedStatus;
  paymentAddress: string | null;
  balances: Balance;
  syncing: boolean;
  progress: OpProgress | null;
  poolReady: boolean;
  unlock: () => Promise<void>;
  lock: () => void;
  refresh: () => Promise<void>;
  balanceOf: (tokenField: bigint) => bigint;
  clearProgress: () => void;
  shieldExec: (args: {
    parts: bigint[];
    tokenField: bigint;
    tokenAddress: `0x${string}` | null;
    symbol: string;
    decimals: number;
  }) => Promise<void>;
  unshieldExec: (args: {
    parts: bigint[];
    tokenField: bigint;
    symbol: string;
    decimals: number;
  }) => Promise<void>;
};

const ShieldedContext = createContext<ShieldedContextValue | null>(null);

export function useShielded(): ShieldedContextValue {
  const v = useContext(ShieldedContext);
  if (!v) throw new Error("useShielded outside ShieldedProvider");
  return v;
}

/** Wallet rejections read as a calm sentence, chain reverts keep their name. */
function opError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied|rejected the request/i.test(msg)) return "Rejected in the wallet.";
  const line = msg.split("\n")[0] ?? msg;
  return line.length > 180 ? line.slice(0, 177) + "…" : line;
}

/** True when a failure smells like the root moved under us — resync and reprove. */
function isStaleRoot(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UnknownRoot|DuplicateCommitment|reverted/i.test(msg) && !/user rejected|denied/i.test(msg);
}

export default function ShieldedProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { data: walletClient } = useWalletClient();

  const [status, setStatus] = useState<ShieldedStatus>("locked");
  const [keys, setKeys] = useState<ShieldedKeys | null>(null);
  const [derivedFor, setDerivedFor] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance>([]);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<OpProgress | null>(null);

  const walletClientRef = useRef(walletClient);
  walletClientRef.current = walletClient;

  // Keys belong to the wallet that signed them; a different account locks the book.
  useEffect(() => {
    if (keys && derivedFor && address !== derivedFor) {
      setKeys(null);
      setDerivedFor(null);
      setStatus("locked");
      setBalances([]);
    }
  }, [address, keys, derivedFor]);

  const scanAndPublish = useCallback((k: ShieldedKeys) => {
    const pool = loadPool(net.key);
    const wallet = loadWallet(net.key, k);
    applyScan(pool, wallet, k);
    saveWallet(net.key, k, wallet);
    setBalances(computeBalance(wallet));
  }, []);

  const refreshWith = useCallback(
    async (k: ShieldedKeys) => {
      setSyncing(true);
      try {
        await syncShieldedPool();
        scanAndPublish(k);
      } finally {
        setSyncing(false);
      }
    },
    [scanAndPublish],
  );

  const unlock = useCallback(async () => {
    if (!address) throw new Error("Connect a wallet first.");
    setStatus("unlocking");
    try {
      const sig = await signMessageAsync({ message: SHIELDED_SIGN_MESSAGE });
      const k = deriveShieldedKeysFromSignature(sig);
      setKeys(k);
      setDerivedFor(address);
      setStatus("ready");
      await refreshWith(k);
    } catch (e) {
      setStatus("locked");
      throw e;
    }
  }, [address, signMessageAsync, refreshWith]);

  const lock = useCallback(() => {
    setKeys(null);
    setDerivedFor(null);
    setStatus("locked");
    setBalances([]);
  }, []);

  const refresh = useCallback(async () => {
    if (keys) await refreshWith(keys);
  }, [keys, refreshWith]);

  const balanceOf = useCallback(
    (tokenField: bigint): bigint => balances.find((b) => b.token === tokenField)?.amount ?? 0n,
    [balances],
  );

  const clearProgress = useCallback(() => setProgress(null), []);

  // ---- executors ------------------------------------------------------------

  const shieldExec = useCallback<ShieldedContextValue["shieldExec"]>(
    async ({ parts, tokenField, tokenAddress, symbol, decimals }) => {
      const k = keys;
      const wc = walletClientRef.current;
      if (!k) throw new Error("Unlock the shielded account first.");
      if (!wc) throw new Error("Connect a wallet first.");

      const prog: OpProgress = { op: "shield", symbol, decimals, parts, current: 0, step: "sync", txs: [], done: false };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      try {
        // One exact approval covers the whole batch on the ERC-20 path.
        if (tokenField !== 0n && tokenAddress) {
          prog.step = "confirm";
          publish();
          const total = parts.reduce((s, p) => s + p, 0n);
          await approvePool(wc, tokenAddress, total);
        }

        for (let i = 0; i < parts.length; i++) {
          prog.current = i;
          for (let attempt = 0; ; attempt++) {
            prog.step = "sync";
            publish();
            const sync = await syncShieldedPool();
            if (!sync) throw new Error(`No shielded pool on ${net.label}.`);

            const note = newNote(parts[i]!, tokenField, k.mpk);
            const c = commitment(note);
            const at = appendProof(sync.pool.commitments.map(hexToField), c);

            prog.step = "prove";
            publish();
            const proof = await proveShieldOffThread(note, c, at);

            // The blinding survives a dying tab: stash before broadcast.
            const wallet = loadWallet(net.key, k);
            stashPendingNote(wallet, note);
            saveWallet(net.key, k, wallet);

            prog.step = "confirm";
            publish();
            try {
              const receipt = await submitShield(wc, {
                token: tokenField,
                value: parts[i]!,
                commitment: fieldToHex(c) as `0x${string}`,
                newRoot: fieldToHex(at.newRoot) as `0x${string}`,
                ciphertext: packCipher(encryptNote(note, k.viewPubHex)),
                proof,
              });

              prog.step = "mined";
              prog.txs.push({ hash: receipt.hash, part: i });
              publish();

              const after = await syncShieldedPool();
              if (after) {
                const w2 = loadWallet(net.key, k);
                recordMyNote(after.pool, w2, k, note, receipt.leafIndex);
                savePool(net.key, after.pool);
                saveWallet(net.key, k, w2);
              }
              break;
            } catch (e) {
              if (isStaleRoot(e) && attempt < 2) continue; // root moved — reprove
              throw e;
            }
          }
        }

        scanAndPublish(k);
        prog.done = true;
        publish();
      } catch (e) {
        prog.error = opError(e);
        publish();
        throw e;
      }
    },
    [keys, scanAndPublish],
  );

  const unshieldExec = useCallback<ShieldedContextValue["unshieldExec"]>(
    async ({ parts, tokenField, symbol, decimals }) => {
      const k = keys;
      const wc = walletClientRef.current;
      if (!k) throw new Error("Unlock the shielded account first.");
      if (!wc?.account) throw new Error("Connect a wallet first.");
      const payout = BigInt(wc.account.address);

      const prog: OpProgress = { op: "unshield", symbol, decimals, parts, current: 0, step: "sync", txs: [], done: false };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      try {
        for (let i = 0; i < parts.length; i++) {
          prog.current = i;
          for (let attempt = 0; ; attempt++) {
            prog.step = "sync";
            publish();
            const sync = await syncShieldedPool();
            if (!sync) throw new Error(`No shielded pool on ${net.label}.`);
            const wallet = loadWallet(net.key, k);
            applyScan(sync.pool, wallet, k);
            saveWallet(net.key, k, wallet);

            const planned = planUnshield(
              sync.pool,
              wallet,
              k,
              parts[i]!,
              tokenField,
              payout,
              BigInt(net.chainId),
            );

            prog.step = "prove";
            publish();
            const proof = await proveTransferOffThread(planned.plan);
            const ciphertexts: [`0x${string}`, `0x${string}`] = [
              packCipher(encryptNote(planned.outputs[0]!.note, planned.outputs[0]!.viewPubHex)),
              packCipher(encryptNote(planned.outputs[1]!.note, planned.outputs[1]!.viewPubHex)),
            ];

            prog.step = "confirm";
            publish();
            try {
              // Free dry-run first: a stale root or spent note rejects here
              // instead of inside a wallet-confirmed transaction.
              await simulateSpend(wc.account.address, proof.spend, ciphertexts, proof.proof);
              const receipt = await submitSpend(wc, proof.spend, ciphertexts, proof.proof);

              prog.step = "mined";
              prog.txs.push({ hash: receipt.hash, part: i });
              publish();

              await syncShieldedPool();
              break;
            } catch (e) {
              if (isStaleRoot(e) && attempt < 2) continue; // root moved — replan
              throw e;
            }
          }
        }

        scanAndPublish(k);
        prog.done = true;
        publish();
      } catch (e) {
        prog.error = opError(e);
        publish();
        throw e;
      }
    },
    [keys, scanAndPublish],
  );

  const value = useMemo<ShieldedContextValue>(
    () => ({
      status,
      paymentAddress: keys?.paymentAddress ?? null,
      balances,
      syncing,
      progress,
      poolReady: Boolean(net.contracts.pool),
      unlock,
      lock,
      refresh,
      balanceOf,
      clearProgress,
      shieldExec,
      unshieldExec,
    }),
    [status, keys, balances, syncing, progress, unlock, lock, refresh, balanceOf, clearProgress, shieldExec, unshieldExec],
  );

  return <ShieldedContext.Provider value={value}>{children}</ShieldedContext.Provider>;
}
