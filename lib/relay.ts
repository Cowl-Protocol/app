"use client";

// The client half of the relayer wire format, ported from
// cli/src/relayer/client.ts and kept identical to it.
//
// A relayer is a submitter, not a custodian. The join-split proof already binds
// `recipient`, `relayer` and `fee` into the circuit's payout tag, so a relayer
// can submit the spend from its own wallet, take the fee leg, and change
// nothing. Alter any of it and the proof stops verifying. What it severs is the
// one link the chain would otherwise print: the gas payer. A spend the relayer
// submits carries no trace of the wallet that built it.
//
// JSON carries bigints as decimal strings and bytes as 0x-hex.
import { useEffect, useState } from "react";
import { activeNetwork } from "./networks";
import { fieldToAddress } from "./shielded/contract";
import type { SpendStruct } from "./shielded/prove";

export type RelayQuote = {
  /** The relayer's payout address — goes into the plan as the `relayer` field. */
  relayer: `0x${string}`;
  /** The relayer's gas cost per spend, wei, in the native coin. */
  feeWei: bigint;
  /** The token the quote was priced in: "0" for native, else the address. */
  token: string;
  /** Fee per spend in that token's base units — what the proof binds. */
  fee: bigint;
  chainId: number;
  pool: `0x${string}`;
};

export type RelayReceipt = {
  hash: `0x${string}`;
  gasUsed: bigint;
  blockNumber: bigint;
};

type WireSpend = {
  membershipRoot: string;
  nullifiers: [string, string];
  commitments: [string, string];
  newRoot: string;
  token: string;
  value: string;
  fee: string;
  recipient: string;
  relayer: string;
};

function encodeSpend(s: SpendStruct): WireSpend {
  return {
    membershipRoot: s.membershipRoot,
    nullifiers: [s.nullifiers[0], s.nullifiers[1]],
    commitments: [s.commitments[0], s.commitments[1]],
    newRoot: s.newRoot,
    token: s.token.toString(),
    value: s.value.toString(),
    fee: s.fee.toString(),
    recipient: s.recipient.toString(),
    relayer: s.relayer.toString(),
  };
}

const hex = (v: unknown, what: string): `0x${string}` => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`Bad ${what} in relay payload.`);
  return v as `0x${string}`;
};
const big = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`Bad ${what} in relay payload.`);
  return BigInt(v);
};

const clean = (url: string) => url.replace(/\/+$/, "");

/**
 * Ask a relayer what it charges and where its fee should be paid.
 *
 * Pass a token address to have the fee priced in that ERC-20, since the fee leg
 * of a spend pays in the spend's own token.
 */
export async function fetchQuote(url: string, token?: `0x${string}`): Promise<RelayQuote> {
  const qs = token ? `?token=${token}` : "";
  let res: Response;
  try {
    res = await fetch(`${clean(url)}/quote${qs}`);
  } catch {
    throw new Error(`No relayer answering at ${url}.`);
  }
  const q = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof q.error === "string" ? q.error : `Relayer refused the quote (${res.status}).`);
  }
  if (typeof q.relayer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.relayer)) {
    throw new Error("Relayer sent a malformed quote.");
  }
  const feeWei = big(q.feeWei, "feeWei");
  return {
    relayer: q.relayer as `0x${string}`,
    feeWei,
    token: typeof q.token === "string" ? q.token : "0",
    fee: q.fee === undefined ? feeWei : big(q.fee, "fee"),
    chainId: Number(q.chainId),
    pool: hex(q.pool, "pool"),
  };
}

/** Hand a proven spend to the relayer and wait for its receipt. */
export async function relaySpend(
  url: string,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<RelayReceipt> {
  let res: Response;
  try {
    res = await fetch(`${clean(url)}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spend: encodeSpend(spend), ciphertexts, proof }),
    });
  } catch {
    throw new Error(`No relayer answering at ${url}.`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Relayer rejected the spend (${res.status}).`);
  }
  return {
    hash: hex(body.hash, "hash"),
    gasUsed: big(body.gasUsed, "gasUsed"),
    blockNumber: big(body.blockNumber, "blockNumber"),
  };
}

/**
 * A quote worth using, or nothing.
 *
 * A relayer serving another chain would hand back a fee bound to the wrong
 * pool, and the spend proved against it could only revert. The same goes for a
 * relayer that is simply down: gasless is the default, so it has to be able to
 * step aside quietly rather than take the withdrawal with it.
 */
export async function tryQuote(
  url: string | undefined,
  chainId: number,
  pool: `0x${string}`,
  token?: `0x${string}`,
): Promise<RelayQuote | null> {
  if (!url) return null;
  try {
    const q = await fetchQuote(url, token);
    if (q.chainId !== chainId) return null;
    if (q.pool.toLowerCase() !== pool.toLowerCase()) return null;
    return q;
  } catch {
    return null;
  }
}

/**
 * Whether a relayer will carry a spend of this token, asked before anything is
 * signed.
 *
 * The screen has to say who pays the gas and how many wallet confirmations are
 * coming, and it has to say it while someone can still change their mind.
 * Discovering the relayer was down after the wallet popped up would mean the
 * withdrawal already put the payer on chain under a promise that it would not.
 */
export function useRelayQuote(
  tokenField: bigint | null,
  enabled: boolean,
): { quote: RelayQuote | null; checking: boolean } {
  const [quote, setQuote] = useState<RelayQuote | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const net = activeNetwork();
    if (!enabled || tokenField === null || !net.defaultRelay || !net.contracts.pool) {
      setQuote(null);
      setChecking(false);
      return;
    }
    let alive = true;
    setChecking(true);
    tryQuote(
      net.defaultRelay,
      net.chainId,
      net.contracts.pool,
      tokenField === 0n ? undefined : (fieldToAddress(tokenField) as `0x${string}`),
    ).then((q) => {
      if (!alive) return;
      setQuote(q);
      setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, [tokenField, enabled]);

  return { quote, checking };
}

/**
 * What one spend costs in gas, before anyone decides who pays it.
 *
 * The same figure the relayer prices against, so the two sides of the choice
 * are quoted from one number: pay it yourself in the native coin, or hand it to
 * a relayer who charges it back in the token you are moving.
 */
export const GAS_PER_SPEND = 5_000_000n;

/**
 * The native-coin cost of a run you submit yourself.
 *
 * Shown whether or not a relayer is standing by, because "Gas payer: You" with
 * no number beside it is not a price. An estimate is honest here — the gas
 * price moves between now and the transaction — so it is labelled as one.
 */
export function useSelfGasEstimate(parts: number, enabled: boolean): bigint | null {
  const [wei, setWei] = useState<bigint | null>(null);

  useEffect(() => {
    if (!enabled || parts <= 0) {
      setWei(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { publicClient } = await import("./useWallet");
        const price = await publicClient.getGasPrice();
        if (alive) setWei(price * GAS_PER_SPEND * BigInt(parts));
      } catch {
        // No estimate is better than a made-up one; the row simply stays away.
        if (alive) setWei(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [parts, enabled]);

  return wei;
}
