"use client";

// The shielded account, as React context.
//
// Unlocking asks the connected wallet for one deterministic signature over a
// fixed domain message and derives the shielded keys from it, in memory only —
// nothing secret ever persists. Once unlocked the provider syncs the pool's
// event log, scans it with the view key, and exposes balances plus the three
// real executors: shield (prove, then the wallet pays the deposit in),
// unshield (prove the join-split, submit through the wallet, value comes out)
// and send (the same join-split with no public leg, one output encrypted to
// the recipient's view key instead of your own).
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
import { planDelays } from "@/lib/spread";
import {
  decodePaymentAddress,
  deriveShieldedKeysFromSignature,
  SHIELDED_SIGN_MESSAGE,
  type ShieldedKeys,
} from "@/lib/shielded/keys";
import { commitment, newNote } from "@/lib/shielded/note";
import { encryptNote, packCipher } from "@/lib/shielded/crypto";
import { fieldToHex, hexToField } from "@/lib/shielded/field";
import { appendProof } from "@/lib/shielded/tree";
import {
  applyScan,
  computeBalance,
  planSend,
  planUnshield,
  recordMyNote,
  stashPendingNote,
  type Balance,
  type Wallet,
} from "@/lib/shielded/pool";
import { loadPool, loadWallet, savePool, saveWallet } from "@/lib/shielded/store";
import { syncShieldedPool } from "@/lib/shielded/sync";
import { approvePool, simulateSpend, submitShield, submitSpend } from "@/lib/shielded/contract";
import { proveShieldOffThread, proveTransferOffThread } from "@/lib/shielded/prover";

const net = activeNetwork();

export type ShieldedStatus = "locked" | "unlocking" | "ready";

export type OpStep = "unlock" | "wait" | "sync" | "prove" | "confirm" | "mined" | "record";

/** A part of a run that reached the chain, and the transaction that carried it. */
export type PartTx = { hash: string; part: number };

export type OpProgress = {
  op: "shield" | "unshield" | "send";
  symbol: string;
  decimals: number;
  parts: bigint[];
  current: number;
  step: OpStep;
  txs: PartTx[];
  done: boolean;
  error?: string;
  /** When the current spread wait ends, so the modal can count down to it. */
  waitUntil?: number;
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
  /** Most one spend can move for this token: a join-split reaches two notes, no more. */
  sendableOf: (tokenField: bigint) => bigint;
  clearProgress: () => void;
  shieldExec: (args: {
    parts: bigint[];
    tokenField: bigint;
    tokenAddress: `0x${string}` | null;
    symbol: string;
    decimals: number;
    /** Scatter the parts across this many milliseconds. */
    spreadMs?: number | null;
    /**
     * Parts of this same run that already landed on chain, so a retry finishes
     * the run instead of starting it over. Their money has moved; sending them
     * again would move it twice.
     */
    done?: PartTx[];
  }) => Promise<void>;
  unshieldExec: (args: {
    parts: bigint[];
    tokenField: bigint;
    symbol: string;
    decimals: number;
    spreadMs?: number | null;
    done?: PartTx[];
  }) => Promise<void>;
  sendExec: (args: {
    /** zcowl payment address of the recipient. */
    to: string;
    value: bigint;
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

/**
 * Give a promise a deadline, resolving to null when it misses it.
 *
 * Used for the bookkeeping that follows a landed deposit. That work reads the
 * pool's whole event log, which on the endpoint that serves history can take
 * minutes under a rate limit, and none of it decides where the money is: the
 * chain already moved it and the note's blinding was written down before the
 * transaction went out. Waiting on it indefinitely only leaves a finished run
 * looking stuck.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** How long the post-deposit filing may take before the run moves on. */
const RECORD_DEADLINE = 25_000;

/**
 * Hold before a part, so a spread's window is actually observed.
 *
 * The wait is published with the moment it ends rather than a countdown of its
 * own: a tab that gets throttled in the background stops ticking, and a clock
 * read from the end time stays honest through that.
 */
async function holdFor(ms: number, prog: OpProgress, publish: () => void): Promise<void> {
  if (ms <= 0) return;
  prog.step = "wait";
  prog.waitUntil = Date.now() + ms;
  publish();
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * The ceiling on one spend, per token.
 *
 * A join-split reads at most two input notes, so a book scattered across many
 * small ones can hold more than any single transfer can move. The screen needs
 * this before it lets someone type an amount the circuit cannot carry.
 */
function sendableCaps(wallet: Wallet): { token: bigint; max: bigint }[] {
  const by = new Map<string, bigint[]>();
  for (const n of wallet.notes) {
    if (n.spent) continue;
    const v = hexToField(n.value);
    if (v === 0n) continue;
    by.set(n.token, [...(by.get(n.token) ?? []), v]);
  }
  return [...by.entries()].map(([token, values]) => ({
    token: hexToField(token),
    max: values
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, 2)
      .reduce((s, v) => s + v, 0n),
  }));
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
  const [sendable, setSendable] = useState<{ token: bigint; max: bigint }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<OpProgress | null>(null);

  const walletClientRef = useRef(walletClient);
  walletClientRef.current = walletClient;

  // Keys belong to the wallet that signed them; a different account locks the book.
  useEffect(() => {
    if (keys && derivedFor && address !== derivedFor) {
      keysRef.current = null;
      setKeys(null);
      setDerivedFor(null);
      setStatus("locked");
      setBalances([]);
      setSendable([]);
    }
  }, [address, keys, derivedFor]);

  const scanAndPublish = useCallback((k: ShieldedKeys) => {
    const pool = loadPool(net.key);
    const wallet = loadWallet(net.key, k);
    applyScan(pool, wallet, k);
    saveWallet(net.key, k, wallet);
    setBalances(computeBalance(wallet));
    setSendable(sendableCaps(wallet));
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

  const keysRef = useRef<ShieldedKeys | null>(null);
  keysRef.current = keys;

  /**
   * The unlocked account, deriving it first if this session has not yet.
   *
   * Callers reach for the keys when they need them rather than being made to
   * unlock in advance: the signature is a step of the operation, not a gate in
   * front of it. Viewing a shielded balance needs it too, which is the one
   * place the button still appears.
   */
  const ensureKeys = useCallback(async (): Promise<ShieldedKeys> => {
    const existing = keysRef.current;
    if (existing) return existing;
    if (!address) throw new Error("Connect a wallet first.");
    setStatus("unlocking");
    try {
      const sig = await signMessageAsync({ message: SHIELDED_SIGN_MESSAGE });
      const k = deriveShieldedKeysFromSignature(sig);
      keysRef.current = k;
      setKeys(k);
      setDerivedFor(address);
      setStatus("ready");
      return k;
    } catch (e) {
      setStatus("locked");
      throw e;
    }
  }, [address, signMessageAsync]);

  const unlock = useCallback(async () => {
    const k = await ensureKeys();
    await refreshWith(k);
  }, [ensureKeys, refreshWith]);

  const lock = useCallback(() => {
    keysRef.current = null;
    setKeys(null);
    setDerivedFor(null);
    setStatus("locked");
    setBalances([]);
    setSendable([]);
  }, []);

  const refresh = useCallback(async () => {
    if (keys) await refreshWith(keys);
  }, [keys, refreshWith]);

  const balanceOf = useCallback(
    (tokenField: bigint): bigint => balances.find((b) => b.token === tokenField)?.amount ?? 0n,
    [balances],
  );

  const sendableOf = useCallback(
    (tokenField: bigint): bigint => sendable.find((s) => s.token === tokenField)?.max ?? 0n,
    [sendable],
  );

  const clearProgress = useCallback(() => setProgress(null), []);

  // Closing mid-run costs different things at different moments: a deposit
  // already broadcast is safe, since its blinding is stashed before the
  // transaction goes out and the next scan adopts it, but parts still queued
  // behind a spread simply never fire. Either way the tab should not go quietly.
  const running = !!progress && !progress.done && !progress.error;
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  // ---- executors ------------------------------------------------------------

  const shieldExec = useCallback<ShieldedContextValue["shieldExec"]>(
    async ({ parts, tokenField, tokenAddress, symbol, decimals, spreadMs, done = [] }) => {
      const wc = walletClientRef.current;
      if (!wc) throw new Error("Connect a wallet first.");

      // A retry carries the parts that already landed. Their deposits are on
      // chain and their money has left the wallet, so they are skipped and kept
      // on screen with the transaction that carried them.
      const landed = new Set(done.map((t) => t.part));
      const firstOpen = parts.findIndex((_, i) => !landed.has(i));
      const prog: OpProgress = {
        op: "shield",
        symbol,
        decimals,
        parts,
        current: firstOpen < 0 ? 0 : firstOpen,
        step: "unlock",
        txs: [...done],
        done: false,
      };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      const delays = spreadMs ? planDelays(parts.length, spreadMs) : parts.map(() => 0);

      try {
        const k = await ensureKeys();
        // One approval covers what is left to deposit. The allowance from the
        // first attempt usually still covers it, and approvePool asks for
        // nothing when it does.
        if (tokenField !== 0n && tokenAddress) {
          prog.step = "confirm";
          publish();
          const total = parts.reduce((s, p, i) => (landed.has(i) ? s : s + p), 0n);
          if (total > 0n) await approvePool(wc, tokenAddress, total);
        }

        for (let i = 0; i < parts.length; i++) {
          if (landed.has(i)) continue;
          prog.current = i;
          await holdFor(delays[i] ?? 0, prog, publish);
          for (let attempt = 0; ; attempt++) {
            prog.step = "sync";
            prog.waitUntil = undefined;
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

              // The deposit is on chain and its blinding is already stashed, so
              // filing it against a leaf is bookkeeping the next scan can redo.
              // It gets a deadline and its failures are swallowed on purpose:
              // this used to be able to strand a run that had fully succeeded.
              prog.step = "record";
              publish();
              try {
                const after = await withDeadline(syncShieldedPool(), RECORD_DEADLINE);
                if (after) {
                  const w2 = loadWallet(net.key, k);
                  recordMyNote(after.pool, w2, k, note, receipt.leafIndex);
                  savePool(net.key, after.pool);
                  saveWallet(net.key, k, w2);
                }
              } catch {
                // The note stays pending; a later scan adopts it by commitment.
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
        prog.waitUntil = undefined;
        publish();
      } catch (e) {
        prog.error = opError(e);
        prog.waitUntil = undefined;
        publish();
        throw e;
      }
    },
    [ensureKeys, scanAndPublish],
  );

  const unshieldExec = useCallback<ShieldedContextValue["unshieldExec"]>(
    async ({ parts, tokenField, symbol, decimals, spreadMs, done = [] }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");
      const payout = BigInt(wc.account.address);

      // Same as a shield retry, and it matters more here: these parts already
      // spent notes, so repeating one would try to spend a nullifier the pool
      // has seen and take a second bite out of the shielded balance.
      const landed = new Set(done.map((t) => t.part));
      const firstOpen = parts.findIndex((_, i) => !landed.has(i));
      const prog: OpProgress = {
        op: "unshield",
        symbol,
        decimals,
        parts,
        current: firstOpen < 0 ? 0 : firstOpen,
        step: "unlock",
        txs: [...done],
        done: false,
      };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      const delays = spreadMs ? planDelays(parts.length, spreadMs) : parts.map(() => 0);

      try {
        const k = await ensureKeys();
        for (let i = 0; i < parts.length; i++) {
          if (landed.has(i)) continue;
          prog.current = i;
          await holdFor(delays[i] ?? 0, prog, publish);
          for (let attempt = 0; ; attempt++) {
            prog.step = "sync";
            prog.waitUntil = undefined;
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

              prog.step = "record";
              publish();
              await withDeadline(syncShieldedPool(), RECORD_DEADLINE).catch(() => null);
              break;
            } catch (e) {
              if (isStaleRoot(e) && attempt < 2) continue; // root moved — replan
              throw e;
            }
          }
        }

        scanAndPublish(k);
        prog.done = true;
        prog.waitUntil = undefined;
        publish();
      } catch (e) {
        prog.error = opError(e);
        prog.waitUntil = undefined;
        publish();
        throw e;
      }
    },
    [ensureKeys, scanAndPublish],
  );

  /**
   * Pay a zcowl address out of the shielded book.
   *
   * The same join-split the boundary uses, with its public leg set to zero:
   * nothing leaves the pool, so the chain sees two spent nullifiers and two
   * fresh commitments and no amount, no asset and no parties. What separates a
   * payment from change is only who each output is encrypted to — the
   * recipient reads the first with their view key, you read the second with
   * yours, and neither ciphertext tells the other apart from outside.
   *
   * One note in, one transaction, no denomination split: a private transfer
   * publishes no amount to round off.
   */
  const sendExec = useCallback<ShieldedContextValue["sendExec"]>(
    async ({ to, value, tokenField, symbol, decimals }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");
      // Malformed addresses die here, before a signature is asked for.
      const recipient = decodePaymentAddress(to);

      const prog: OpProgress = {
        op: "send",
        symbol,
        decimals,
        parts: [value],
        current: 0,
        step: "unlock",
        txs: [],
        done: false,
      };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      try {
        const k = await ensureKeys();
        for (let attempt = 0; ; attempt++) {
          prog.step = "sync";
          publish();
          const sync = await syncShieldedPool();
          if (!sync) throw new Error(`No shielded pool on ${net.label}.`);
          const wallet = loadWallet(net.key, k);
          applyScan(sync.pool, wallet, k);
          saveWallet(net.key, k, wallet);

          const planned = planSend(
            sync.pool,
            wallet,
            k,
            recipient,
            value,
            tokenField,
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
            await simulateSpend(wc.account.address, proof.spend, ciphertexts, proof.proof);
            const receipt = await submitSpend(wc, proof.spend, ciphertexts, proof.proof);

            prog.step = "mined";
            prog.txs.push({ hash: receipt.hash, part: 0 });
            publish();

            prog.step = "record";
            publish();
            await withDeadline(syncShieldedPool(), RECORD_DEADLINE).catch(() => null);
            break;
          } catch (e) {
            if (isStaleRoot(e) && attempt < 2) continue; // root moved — replan
            throw e;
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
    [ensureKeys, scanAndPublish],
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
      sendableOf,
      clearProgress,
      shieldExec,
      unshieldExec,
      sendExec,
    }),
    [
      status,
      keys,
      balances,
      syncing,
      progress,
      unlock,
      lock,
      refresh,
      balanceOf,
      sendableOf,
      clearProgress,
      shieldExec,
      unshieldExec,
      sendExec,
    ],
  );

  return <ShieldedContext.Provider value={value}>{children}</ShieldedContext.Provider>;
}
