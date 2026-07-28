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
  mergesNeeded,
  planConsolidate,
  planSend,
  planUnshield,
  recordMyNote,
  stashPendingNote,
  type Balance,
  type Wallet,
} from "@/lib/shielded/pool";
import { loadPool, loadWallet, savePool, saveWallet } from "@/lib/shielded/store";
import { syncShieldedPool } from "@/lib/shielded/sync";
import {
  approvePool,
  fieldToAddress,
  quoteBestExactOutput,
  simulateSpend,
  simulateTrade,
  submitShield,
  submitSpend,
  submitTrade,
  venueLeg,
  type TradeSubmission,
} from "@/lib/shielded/contract";
import { proveShieldOffThread, proveTransferOffThread } from "@/lib/shielded/prover";
import { relaySpend, relayTrade, tryQuote } from "@/lib/relay";

const net = activeNetwork();

export type ShieldedStatus = "locked" | "unlocking" | "ready";

export type OpStep = "unlock" | "wait" | "sync" | "prove" | "confirm" | "mined" | "record";

/** A part of a run that reached the chain, and the transaction that carried it. */
export type PartTx = { hash: string; part: number };

export type OpProgress = {
  op: "shield" | "unshield" | "send" | "trade";
  symbol: string;
  decimals: number;
  parts: bigint[];
  current: number;
  step: OpStep;
  txs: PartTx[];
  done: boolean;
  /** True while a relayer is carrying the parts, so the screen can say who pays. */
  relayed?: boolean;
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
    /**
     * Skip the relayer and submit from the wallet — the CLI's --self.
     *
     * The run never asks for a quote, so no fee is drawn from the notes; the
     * wallet pays gas and appears on chain as the caller. This is what lets a
     * balance smaller than one relayer fee move at all.
     */
    selfPay?: boolean;
  }) => Promise<void>;
  /**
   * Merge notes until one spend can carry `target`, or as far as it can get.
   *
   * Runs the rounds back to back rather than asking for each: the count is
   * known before it starts, and stopping halfway leaves a book no better
   * arranged than it was.
   */
  consolidateExec: (args: {
    tokenField: bigint;
    symbol: string;
    decimals: number;
    /**
     * The payment this is clearing the way for — not the total draw.
     *
     * The relayer's fee rides in the same spend and has to be merged for too,
     * but it is quoted here, per round, rather than passed in: a card reads its
     * quote once and can be minutes stale by the time someone clicks, and a
     * merge aimed at yesterday's fee finishes exactly short of today's.
     */
    target: bigint;
    /** Rounds confirm in the wallet and pay no fee from the notes — see unshieldExec. */
    selfPay?: boolean;
  }) => Promise<void>;
  sendExec: (args: {
    /** zcowl payment address of the recipient. */
    to: string;
    value: bigint;
    tokenField: bigint;
    symbol: string;
    decimals: number;
    /** Submit from the wallet, no relayer fee — see unshieldExec. */
    selfPay?: boolean;
  }) => Promise<void>;
  /**
   * Swap shielded value through the venue, atomically.
   *
   * One adapter call carries two chained proofs: a spend whose payout leg names
   * the adapter, and a shield for the exact output, proven against the root the
   * spend leaves behind. The trade is exact-output — `amountOut` is fixed and
   * the spend's value is the input cap the router may draw up to.
   */
  tradeExec: (args: {
    /** Exactly what arrives, in the out token's base units. */
    amountOut: bigint;
    tokenOutField: bigint;
    outSymbol: string;
    outDecimals: number;
    /** The input side — native unless the output is native (then USDG). */
    tokenInField: bigint;
    /** Submit from the wallet — the input cap gains 1% headroom, refunded to it. */
    selfPay?: boolean;
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
    async ({ parts, tokenField, symbol, decimals, spreadMs, done = [], selfPay = false }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");
      const payout = BigInt(wc.account.address);

      // Same as a shield retry, and it matters more here: these parts already
      // spent notes, so repeating one would try to spend a nullifier the pool
      // has seen and take a second bite out of the shielded balance.
      const landed = new Set(done.map((t) => t.part));
      const firstOpen = parts.findIndex((_, i) => !landed.has(i));
      // Re-asked per part: a relayer can go down mid-run, and the screen has to
      // stop claiming gasless the moment the wallet starts paying.
      let relayed = false;
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

            // Gasless is the default, so the quote is asked for first and the
            // fee it names is bound into the proof. A relayer that is down, or
            // serving another chain, simply yields null and the spend falls
            // back to the wallet — the withdrawal must not go down with it.
            // Self-paid skips the question: no quote, no fee from the notes.
            const quote = selfPay
              ? null
              : await tryQuote(
                  net.defaultRelay,
                  net.chainId,
                  net.contracts.pool!,
                  tokenField === 0n ? undefined : (fieldToAddress(tokenField) as `0x${string}`),
                );
            if (relayed !== !!quote) {
              relayed = !!quote;
              prog.relayed = relayed;
            }

            const planned = planUnshield(
              sync.pool,
              wallet,
              k,
              parts[i]!,
              tokenField,
              payout,
              BigInt(net.chainId),
              quote?.fee ?? 0n,
              quote ? BigInt(quote.relayer) : 0n,
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
              // instead of inside a wallet-confirmed transaction. Simulated as
              // the relayer when one is carrying it, since that is the account
              // the pool will see.
              await simulateSpend(
                quote ? quote.relayer : wc.account.address,
                proof.spend,
                ciphertexts,
                proof.proof,
              );
              // Relayed, no wallet confirmation is asked for at all: the proof
              // binds the relayer and its fee, so it submits or it reverts.
              const receipt = quote
                ? await relaySpend(net.defaultRelay!, proof.spend, ciphertexts, proof.proof)
                : await submitSpend(wc, proof.spend, ciphertexts, proof.proof);

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
   * The same join-split the boundary uses, with no payout leg: the chain sees
   * two spent nullifiers and two fresh commitments, and neither the amount nor
   * either party. What separates a payment from change is only who each output
   * is encrypted to — the recipient reads the first with their view key, you
   * read the second with yours, and neither ciphertext tells the other apart
   * from outside.
   *
   * Gasless by default, and the trade that comes with it is deliberate. A
   * relayer's fee is paid out of these same notes, which is value leaving, and
   * the circuit pins the public token field to the real asset the moment
   * anything does. So a relayed payment names its asset; a self-paid one need
   * not. It is the better default anyway: the asset is largely inferable from
   * the sender's own public deposits, whereas relaying is the only thing that
   * keeps their wallet off the chain entirely — and on a payment, hiding the
   * sender is the point.
   *
   * One note in, one transaction, no denomination split: a private transfer
   * publishes no amount to round off.
   */
  const sendExec = useCallback<ShieldedContextValue["sendExec"]>(
    async ({ to, value, tokenField, symbol, decimals, selfPay = false }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");
      // Malformed addresses die here, before a signature is asked for.
      const recipient = decodePaymentAddress(to);

      // Re-asked per attempt, as at the boundary: a relayer can go down between
      // a replan and the next, and the screen has to stop claiming gasless the
      // moment the wallet starts paying.
      let relayed = false;
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

          // Gasless is the default here too, and it is worth more on a payment
          // than at the boundary: relayed, the sender's wallet never appears on
          // chain at all. A relayer that is down, serving another chain, or
          // unable to price this asset yields null, and the send falls back to
          // the wallet rather than failing — that fallback is also the more
          // private shape for the asset, since a spend paying no fee need not
          // name it. See planSend. Self-paid takes that branch on purpose: the
          // fee that would otherwise leave these notes is the whole reason a
          // small balance cannot move.
          const quote = selfPay
            ? null
            : await tryQuote(
                net.defaultRelay,
                net.chainId,
                net.contracts.pool!,
                tokenField === 0n ? undefined : (fieldToAddress(tokenField) as `0x${string}`),
              );
          if (relayed !== !!quote) {
            relayed = !!quote;
            prog.relayed = relayed;
          }

          const planned = planSend(
            sync.pool,
            wallet,
            k,
            recipient,
            value,
            tokenField,
            BigInt(net.chainId),
            quote?.fee ?? 0n,
            quote ? BigInt(quote.relayer) : 0n,
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
            // Dry-run as whoever will actually send it, so a stale root or a
            // spent note rejects here rather than inside a confirmed wallet
            // transaction.
            await simulateSpend(
              quote ? quote.relayer : wc.account.address,
              proof.spend,
              ciphertexts,
              proof.proof,
            );
            // Relayed, no wallet confirmation is asked for at all: the proof
            // binds the relayer and its fee, so it submits or it reverts.
            const receipt = quote
              ? await relaySpend(net.defaultRelay!, proof.spend, ciphertexts, proof.proof)
              : await submitSpend(wc, proof.spend, ciphertexts, proof.proof);

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

  /**
   * The private trade, ported from the CLI's tradeOnChain and shaped like the
   * spends above: sync, quote, prove, dry-run, submit, record.
   *
   * The venue is priced inside the run, seconds before proving, not when the
   * card was drawn — the spend's value is the swap's hard input cap, fixed at
   * proving time, and a quote gone stale by minutes is the difference between a
   * trade and a revert. Self-submitted, the cap gains 1% of headroom and the
   * adapter refunds whatever the router does not draw to the submitter — the
   * trader's own wallet. Relayed, the cap stays at the bare quote, because that
   * same refund would land on the relayer as a stray tip instead.
   */
  const tradeExec = useCallback<ShieldedContextValue["tradeExec"]>(
    async ({ amountOut, tokenOutField, outSymbol, outDecimals, tokenInField, selfPay = false }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");
      const adapter = net.contracts.tradeAdapter;
      if (!adapter) throw new Error(`No trade venue on ${net.label}.`);

      let relayed = false;
      const prog: OpProgress = {
        op: "trade",
        symbol: outSymbol,
        decimals: outDecimals,
        parts: [amountOut],
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

          // Gasless is the default here too, and worth the most on a trade: the
          // fee comes out of the notes being spent and the relayer submits, so
          // no wallet of yours appears anywhere near the swap. A relayer that
          // is down yields null and the wallet takes over — with the headroom
          // rule flipping to match, since the refund then goes home.
          const quote = selfPay
            ? null
            : await tryQuote(
                net.defaultRelay,
                net.chainId,
                net.contracts.pool!,
                tokenInField === 0n ? undefined : (fieldToAddress(tokenInField) as `0x${string}`),
                "trade",
              );
          if (relayed !== !!quote) {
            relayed = !!quote;
            prog.relayed = relayed;
          }

          // Priced across every fee tier — pairs live where their liquidity
          // is, and the winning tier rides into the submission per trade.
          const best = await quoteBestExactOutput(
            net,
            venueLeg(net, tokenInField),
            venueLeg(net, tokenOutField),
            amountOut,
          );
          const quotedIn = best.amount;
          const maxIn = quotedIn + (quote ? 0n : quotedIn / 100n);

          // Leg one: unshield maxIn + fee to the adapter, change back to us.
          const planned = planUnshield(
            sync.pool,
            wallet,
            k,
            maxIn,
            tokenInField,
            BigInt(adapter),
            BigInt(net.chainId),
            quote?.fee ?? 0n,
            quote ? BigInt(quote.relayer) : 0n,
          );

          prog.step = "prove";
          publish();
          const spendProof = await proveTransferOffThread(planned.plan);
          const spendCiphertexts: [`0x${string}`, `0x${string}`] = [
            packCipher(encryptNote(planned.outputs[0]!.note, planned.outputs[0]!.viewPubHex)),
            packCipher(encryptNote(planned.outputs[1]!.note, planned.outputs[1]!.viewPubHex)),
          ];

          // Leg two: shield the exact output, proven against the root leg one
          // makes. The chain assert is what makes the atomicity real on the
          // client side — a tree that moved between the two provings would
          // produce a shield the pool must reject.
          const leavesAfter = [
            ...sync.pool.commitments.map(hexToField),
            hexToField(spendProof.spend.commitments[0]),
            hexToField(spendProof.spend.commitments[1]),
          ];
          const outNote = newNote(amountOut, tokenOutField, k.mpk);
          const outCommitment = commitment(outNote);
          const at = appendProof(leavesAfter, outCommitment);
          if (fieldToHex(at.oldRoot) !== spendProof.spend.newRoot) {
            throw new Error("The trade legs do not chain — resync and retry.");
          }
          const shieldProof = await proveShieldOffThread(outNote, outCommitment, at);

          const submission: TradeSubmission = {
            spend: spendProof.spend,
            spendCiphertexts,
            spendProof: spendProof.proof,
            tokenOut: tokenOutField,
            amountOut,
            poolFee: best.feeTier,
            shieldCommitment: fieldToHex(outCommitment) as `0x${string}`,
            shieldNewRoot: fieldToHex(at.newRoot) as `0x${string}`,
            shieldCiphertext: packCipher(encryptNote(outNote, k.viewPubHex)),
            shieldProof: shieldProof.proof,
          };

          // The output note's secrets survive a dying tab: stash before broadcast.
          const w1 = loadWallet(net.key, k);
          stashPendingNote(w1, outNote);
          saveWallet(net.key, k, w1);

          prog.step = "confirm";
          publish();
          try {
            // Free dry-run as whoever will actually submit. A stale root, a
            // spent note, or a venue that ticked past the input cap all reject
            // here — before a wallet confirmation, with nothing broadcast —
            // and the retry loop re-quotes against the price that moved.
            await simulateTrade(quote ? quote.relayer : wc.account.address, submission);
            const receipt = quote
              ? await relayTrade(net.defaultRelay!, submission)
              : await submitTrade(wc, submission);

            prog.step = "mined";
            prog.txs.push({ hash: receipt.hash, part: 0 });
            publish();

            prog.step = "record";
            publish();
            try {
              const after = await withDeadline(syncShieldedPool(), RECORD_DEADLINE);
              if (after) {
                const w2 = loadWallet(net.key, k);
                recordMyNote(after.pool, w2, k, outNote, at.leafIndex);
                savePool(net.key, after.pool);
                saveWallet(net.key, k, w2);
              }
            } catch {
              // The note stays pending; a later scan adopts it by commitment.
            }
            break;
          } catch (e) {
            if (isStaleRoot(e) && attempt < 2) continue; // root or price moved — replan both legs
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

  /**
   * Merge the two largest notes, over and over, until a spend of `target` fits
   * in two. Each round is an ordinary join-split back to yourself.
   *
   * Gasless like everything else, which matters here for a reason of its own:
   * merging is what someone does immediately before a private send, so a run of
   * self-paid rounds would put their wallet on chain moments before the relayed
   * spend it was clearing the way for. That timing lines the two up. Relaying
   * the rounds too is what stops the preparation from identifying the payment.
   */
  const consolidateExec = useCallback<ShieldedContextValue["consolidateExec"]>(
    async ({ tokenField, symbol, decimals, target, selfPay = false }) => {
      const wc = walletClientRef.current;
      if (!wc?.account) throw new Error("Connect a wallet first.");

      const k = await ensureKeys();
      const sync0 = await syncShieldedPool();
      if (!sync0) throw new Error(`No shielded pool on ${net.label}.`);
      const wallet0 = loadWallet(net.key, k);
      applyScan(sync0.pool, wallet0, k);
      saveWallet(net.key, k, wallet0);

      const relayToken =
        tokenField === 0n ? undefined : (fieldToAddress(tokenField) as `0x${string}`);
      // Self-paid rounds pay no fee from the notes, so the count is taken at
      // fee zero and every round buys its full ceiling.
      const quote0 = selfPay
        ? null
        : await tryQuote(net.defaultRelay, net.chainId, net.contracts.pool!, relayToken);

      // Each relayed round pays a fee out of the pair it merges, so the count
      // has to be taken against that fee or it reads low and the run stops
      // short — the exact failure the screen's round number must not have.
      // The send this clears the way for pays a fee out of the same spend, so
      // the ceiling has to clear the payment AND that fee — quoted here so it is
      // today's, not whatever the card last saw.
      const rounds = mergesNeeded(wallet0, tokenField, target + (quote0?.fee ?? 0n), quote0?.fee ?? 0n);
      if (rounds < 0) throw new Error("Even merged, this balance cannot cover that amount.");
      if (rounds === 0) return;

      // One "part" per round, so the modal counts them the way it counts parts.
      let relayed = !!quote0;
      const prog: OpProgress = {
        op: "unshield",
        symbol,
        decimals,
        parts: Array.from({ length: rounds }, () => 0n),
        current: 0,
        step: "unlock",
        txs: [],
        done: false,
        relayed,
      };
      const publish = () => setProgress({ ...prog, txs: [...prog.txs] });
      publish();

      // A ceiling on rounds rather than a fixed count. The estimate above is
      // taken against one quote, and gas moves: a dearer fee mid-run buys less
      // ceiling per round than was counted on, and stopping at the original
      // number would leave the send still capped after paying for every round.
      // So the loop asks the book itself whether it is there yet, and the
      // headroom is what keeps a relayer whose price is climbing from turning
      // that into an unbounded run.
      const MAX_EXTRA_ROUNDS = 3;

      try {
        merging: for (let i = 0; ; i++) {
          if (i >= rounds + MAX_EXTRA_ROUNDS) {
            throw new Error("Merging is not gaining ground — the relayer's fee is eating each round.");
          }
          for (let attempt = 0; ; attempt++) {
            prog.step = "sync";
            prog.current = i;
            publish();
            const sync = await syncShieldedPool();
            if (!sync) throw new Error(`No shielded pool on ${net.label}.`);
            const wallet = loadWallet(net.key, k);
            applyScan(sync.pool, wallet, k);
            saveWallet(net.key, k, wallet);

            // Re-asked per round: a relayer can go down mid-run, and the fee it
            // charges is what the next round has to be planned against.
            const quote = selfPay
              ? null
              : await tryQuote(net.defaultRelay, net.chainId, net.contracts.pool!, relayToken);
            if (relayed !== !!quote) {
              relayed = !!quote;
              prog.relayed = relayed;
            }

            // Done the moment the book can carry the target, which is the
            // question the run actually exists to answer.
            const left = mergesNeeded(wallet, tokenField, target + (quote?.fee ?? 0n), quote?.fee ?? 0n);
            if (left === 0) break merging;
            if (left < 0) throw new Error("Even merged, this balance cannot cover that amount.");
            // The estimate was low; let the row appear rather than overflow it.
            while (prog.parts.length < i + 1) prog.parts.push(0n);

            const planned = planConsolidate(
              sync.pool,
              wallet,
              k,
              tokenField,
              BigInt(net.chainId),
              quote?.fee ?? 0n,
              quote ? BigInt(quote.relayer) : 0n,
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
              await simulateSpend(
                quote ? quote.relayer : wc.account.address,
                proof.spend,
                ciphertexts,
                proof.proof,
              );
              const receipt = quote
                ? await relaySpend(net.defaultRelay!, proof.spend, ciphertexts, proof.proof)
                : await submitSpend(wc, proof.spend, ciphertexts, proof.proof);
              prog.step = "mined";
              prog.txs.push({ hash: receipt.hash, part: i });
              publish();
              prog.step = "record";
              publish();
              await withDeadline(syncShieldedPool(), RECORD_DEADLINE).catch(() => null);
              break;
            } catch (e) {
              if (isStaleRoot(e) && attempt < 2) continue;
              throw e;
            }
          }
        }
        // The estimate was an upper bound on a moving fee, so a run that got
        // there sooner should not keep reporting rounds it never had to make.
        prog.parts = prog.parts.slice(0, Math.max(prog.txs.length, 1));
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
      tradeExec,
      consolidateExec,
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
      tradeExec,
      consolidateExec,
    ],
  );

  return <ShieldedContext.Provider value={value}>{children}</ShieldedContext.Provider>;
}
