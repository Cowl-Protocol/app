"use client";

// Client for the on-chain ShieldedPool, browser edition.
//
// Port of cli/src/shielded/contract.ts with one structural change: writes go
// through the connected wallet's viem WalletClient (wagmi) instead of a local
// PrivateKeyAccount. The contract holds a root but no tree — commitments are an
// append-only event log and every client rebuilds the depth-20 tree locally.
// A proof is only valid while its root is current: sync immediately before
// proving, and treat a revert as "someone deposited first" rather than a bug.
import { decodeEventLog } from "viem";
import type { Address, Hash, TransactionReceipt, WalletClient } from "viem";
import { publicClient } from "../useWallet";
import { activeNetwork, toViemChain, type NetworkDef } from "../networks";
import type { ShieldProof, SpendStruct } from "./prove";

export const SHIELDED_POOL_ABI = [
  { type: "error", name: "DuplicateCommitment", inputs: [] },
  { type: "error", name: "TreeFull", inputs: [] },
  { type: "error", name: "ZeroValue", inputs: [] },
  { type: "error", name: "NotAField", inputs: [] },
  { type: "error", name: "WrongDeposit", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "UnknownRoot", inputs: [] },
  { type: "error", name: "AlreadySpent", inputs: [] },
  { type: "error", name: "RepeatedNullifier", inputs: [] },
  { type: "error", name: "NoRecipient", inputs: [] },
  { type: "error", name: "BadCipherLength", inputs: [] },
  { type: "error", name: "ExceedsPooledValue", inputs: [] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NoPendingSwap", inputs: [] },
  { type: "error", name: "SwapNotReady", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "newRoot", type: "bytes32" },
      { name: "ciphertext", type: "bytes" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "spend",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "membershipRoot", type: "bytes32" },
          { name: "nullifiers", type: "bytes32[2]" },
          { name: "commitments", type: "bytes32[2]" },
          { name: "newRoot", type: "bytes32" },
          { name: "token", type: "uint256" },
          { name: "value", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "relayer", type: "address" },
        ],
      },
      { name: "ciphertexts", type: "bytes[2]" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "nextLeafIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "knownRoot", stateMutability: "view", inputs: [{ name: "r", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "committed", stateMutability: "view", inputs: [{ name: "c", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nullifierSpent", stateMutability: "view", inputs: [{ name: "n", type: "bytes32" }], outputs: [{ type: "bool" }] },
  {
    type: "event",
    name: "NoteCommitted",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "NoteCipher",
    inputs: [
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "ciphertext", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Nullified",
    inputs: [{ name: "nullifier", type: "bytes32", indexed: true }],
  },
] as const;

/** The pool address for this network, or null when it has not been deployed there. */
export function poolAddress(net: NetworkDef): Address | null {
  return net.contracts.pool ?? null;
}

/** A field-encoded address, the way the proof carries it, back to a 20-byte address. */
export function fieldToAddress(x: bigint): Address {
  return `0x${x.toString(16).padStart(40, "0")}` as Address;
}

export type ShieldReceipt = {
  hash: Hash;
  /** Leaf index the CONTRACT assigned — authoritative, not the local guess. */
  leafIndex: number;
  commitment: `0x${string}`;
  gasUsed: bigint;
  blockNumber: bigint;
};

/**
 * Submit a shield deposit through the connected wallet and read the assigned
 * leaf index back out of the receipt. Native deposits carry `value` as
 * msg.value; ERC-20 deposits need an allowance first (approvePool).
 */
export async function submitShield(
  wallet: WalletClient,
  args: {
    token: bigint;
    value: bigint;
    commitment: `0x${string}`;
    newRoot: `0x${string}`;
    /** The note encrypted to the depositor's own view key, packed to 158 bytes. */
    ciphertext: `0x${string}`;
    proof: ShieldProof;
  },
): Promise<ShieldReceipt> {
  const net = activeNetwork();
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  const account = wallet.account;
  if (!account) throw new Error("Connect a wallet first.");

  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "shield",
    args: [args.token, args.value, args.commitment, args.newRoot, args.ciphertext, args.proof.proof],
    value: args.token === 0n ? args.value : 0n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Shield transaction reverted (${hash}).`);

  const committed = readNoteCommitted(receipt, pool);
  if (!committed) throw new Error(`Shield landed but emitted no NoteCommitted event (${hash}).`);

  return {
    hash,
    leafIndex: committed.leafIndex,
    commitment: committed.commitment,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

export type SpendReceipt = {
  hash: Hash;
  gasUsed: bigint;
  blockNumber: bigint;
  /** Both output leaves the contract assigned, paired to their commitment. */
  outputs: { commitment: `0x${string}`; leafIndex: number }[];
};

function spendArgs(spend: SpendStruct, ciphertexts: [`0x${string}`, `0x${string}`], proof: `0x${string}`) {
  return [
    {
      membershipRoot: spend.membershipRoot,
      nullifiers: [spend.nullifiers[0], spend.nullifiers[1]] as readonly [`0x${string}`, `0x${string}`],
      commitments: [spend.commitments[0], spend.commitments[1]] as readonly [`0x${string}`, `0x${string}`],
      newRoot: spend.newRoot,
      token: spend.token,
      value: spend.value,
      fee: spend.fee,
      recipient: fieldToAddress(spend.recipient),
      relayer: fieldToAddress(spend.relayer),
    },
    ciphertexts,
    proof,
  ] as const;
}

/** Dry-run a spend against the pool's current state — a free eth_call. */
export async function simulateSpend(
  from: Address,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<void> {
  const net = activeNetwork();
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  await publicClient.simulateContract({
    account: from,
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "spend",
    args: spendArgs(spend, ciphertexts, proof),
  });
}

/** Submit a join-split spend through the connected wallet. */
export async function submitSpend(
  wallet: WalletClient,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<SpendReceipt> {
  const net = activeNetwork();
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  const account = wallet.account;
  if (!account) throw new Error("Connect a wallet first.");

  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "spend",
    args: spendArgs(spend, ciphertexts, proof),
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Spend transaction reverted (${hash}).`);

  return {
    hash,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    outputs: readAllNoteCommitted(receipt, pool),
  };
}

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Approve the pool to pull an ERC-20 deposit. Approves exactly `value`, never
 * an unlimited allowance. Returns null when the allowance already covers it.
 */
export async function approvePool(wallet: WalletClient, token: Address, value: bigint): Promise<Hash | null> {
  const net = activeNetwork();
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  const account = wallet.account;
  if (!account) throw new Error("Connect a wallet first.");

  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: "allowance",
    args: [account.address, pool],
  });
  if (current >= value) return null;

  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [pool, value],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ---- event log --------------------------------------------------------------

export type ChainLeaf = { index: number; commitment: `0x${string}`; cipher?: `0x${string}` };
export type ChainLeaves = {
  leaves: ChainLeaf[];
  nullifiers: `0x${string}`[];
  totalLeaves: number;
  root: `0x${string}`;
  latestBlock: bigint;
};

/**
 * Read NoteCommitted leaves from `fromBlock` through the current head. The
 * event log IS the pool's history; this is how the local tree learns about
 * every deposit. The head is pinned before the log query so the cursor can
 * never step past events that land mid-read.
 */
export async function fetchLeaves(net: NetworkDef, fromBlock: bigint): Promise<ChainLeaves> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  const latestBlock = await publicClient.getBlockNumber();
  const logs = fromBlock > latestBlock ? [] : await fetchPoolEvents(pool, fromBlock, latestBlock);

  const leafByIndex = new Map<number, ChainLeaf>();
  const cipherByIndex = new Map<number, `0x${string}`>();
  const nullifiers: `0x${string}`[] = [];
  for (const log of logs) {
    if (log.eventName === "NoteCommitted") {
      const commitment = log.args.commitment as `0x${string}` | undefined;
      const leafIndex = log.args.leafIndex as number | undefined;
      if (commitment === undefined || leafIndex === undefined) continue;
      leafByIndex.set(Number(leafIndex), { index: Number(leafIndex), commitment });
    } else if (log.eventName === "NoteCipher") {
      const leafIndex = log.args.leafIndex as number | undefined;
      const ciphertext = log.args.ciphertext as `0x${string}` | undefined;
      if (leafIndex === undefined || ciphertext === undefined) continue;
      cipherByIndex.set(Number(leafIndex), ciphertext);
    } else if (log.eventName === "Nullified") {
      const nullifier = log.args.nullifier as `0x${string}` | undefined;
      if (nullifier !== undefined) nullifiers.push(nullifier);
    }
  }
  const leaves: ChainLeaf[] = [...leafByIndex.values()]
    .map((l) => ({ ...l, cipher: cipherByIndex.get(l.index) }))
    .sort((a, b) => a.index - b.index);

  // Read both at the block the log was read through — a deposit landing between
  // the queries must not look like a hole in our log.
  const [totalLeaves, root] = await Promise.all([
    publicClient.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "nextLeafIndex",
      blockNumber: latestBlock,
    }),
    publicClient.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "root",
      blockNumber: latestBlock,
    }),
  ]);
  return { leaves, nullifiers, totalLeaves: Number(totalLeaves), root, latestBlock };
}

type PoolLog = { eventName: string; args: Record<string, unknown> };

/**
 * getContractEvents that survives providers capping how many blocks one
 * eth_getLogs may span: on a range rejection the cap is parsed out of the
 * message when the provider names it, and the range refetches in cap-sized
 * windows, in small concurrent groups. Blind halving is the fallback.
 */
async function fetchPoolEvents(pool: Address, fromBlock: bigint, toBlock: bigint): Promise<PoolLog[]> {
  try {
    const logs = await publicClient.getContractEvents({ address: pool, abi: SHIELDED_POOL_ABI, fromBlock, toBlock });
    return logs as unknown as PoolLog[];
  } catch (e) {
    const msg = (e as Error).message;
    const named = /(?:blocks?\D{0,20}|is )(\d{2,8})(?:\s*blocks?)?/i.exec(msg);
    const rangeError = /limit|range|exceed|too (?:many|large|broad)/i.test(msg);
    if (!rangeError || toBlock <= fromBlock) throw e;

    const span = toBlock - fromBlock + 1n;
    let cap = named ? BigInt(named[1]!) : span / 2n;
    if (cap < 1n || cap >= span) cap = span / 2n;

    const windows: [bigint, bigint][] = [];
    for (let start = fromBlock; start <= toBlock; start += cap) {
      const end = start + cap - 1n < toBlock ? start + cap - 1n : toBlock;
      windows.push([start, end]);
    }

    const out: PoolLog[] = [];
    const GROUP = 6; // per roundtrip, small enough to stay under rate limits
    for (let i = 0; i < windows.length; i += GROUP) {
      const group = windows.slice(i, i + GROUP);
      const results = await Promise.all(group.map(([a, b]) => fetchPoolEvents(pool, a, b)));
      for (const r of results) out.push(...r);
    }
    return out;
  }
}

/** Pull the NoteCommitted event out of a receipt, ignoring unrelated logs. */
function readNoteCommitted(
  receipt: TransactionReceipt,
  pool: Address,
): { commitment: `0x${string}`; leafIndex: number } | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: SHIELDED_POOL_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "NoteCommitted") continue;
      return {
        commitment: decoded.args.commitment,
        leafIndex: Number(decoded.args.leafIndex),
      };
    } catch {
      // Not one of ours — a token transfer log on the ERC-20 path, say.
    }
  }
  return null;
}

/** Every NoteCommitted in a receipt, in log order — a spend emits two. */
function readAllNoteCommitted(
  receipt: TransactionReceipt,
  pool: Address,
): { commitment: `0x${string}`; leafIndex: number }[] {
  const out: { commitment: `0x${string}`; leafIndex: number }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: SHIELDED_POOL_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "NoteCommitted") continue;
      out.push({ commitment: decoded.args.commitment, leafIndex: Number(decoded.args.leafIndex) });
    } catch {
      // Not one of ours.
    }
  }
  return out;
}
