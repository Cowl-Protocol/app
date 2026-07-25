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
export async function fetchLeaves(
  net: NetworkDef,
  fromBlock: bigint,
  client: PoolClient = publicClient,
): Promise<ChainLeaves> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  const latestBlock = await client.getBlockNumber();
  const logs = fromBlock > latestBlock ? [] : await fetchPoolEvents(client, pool, fromBlock, latestBlock, true);

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
    client.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "nextLeafIndex",
      blockNumber: latestBlock,
    }),
    client.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "root",
      blockNumber: latestBlock,
    }),
  ]);
  return { leaves, nullifiers, totalLeaves: Number(totalLeaves), root, latestBlock };
}

type PoolLog = { eventName: string; args: Record<string, unknown>; blockNumber: bigint | null };

/** The read surface the log replay needs — the app's shared client satisfies it. */
type PoolClient = Pick<typeof publicClient, "getBlockNumber" | "readContract" | "getContractEvents">;

/** Window sizes to try when a provider caps eth_getLogs without naming its cap. */
const CAP_LADDER = [500_000n, 100_000n, 10_000n, 1_000n, 100n];

/** Windows in flight at once, at the start. Throttling walks this down. */
const GROUP = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discovered cap per pool address, so a second sync never re-probes. */
const capCache = new Map<string, bigint>();

function isRangeError(message: string): boolean {
  return /limit|range|exceed|too (?:many|large|broad)/i.test(message);
}

/** The cap a provider named in its rejection, when it named one. */
function namedCap(message: string): bigint | null {
  const m = /(?:blocks?\D{0,20}|is )(\d{2,8})(?:\s*blocks?)?/i.exec(message);
  return m ? BigInt(m[1]!) : null;
}

/**
 * Find the widest window this provider will serve, by trying a descending
 * ladder once and remembering the answer.
 *
 * The ladder replaces what used to be blind halving. Halving looks reasonable
 * and behaves terribly against a provider that caps at a thousand blocks and
 * declines to say so: each rejected window splits into two more, so covering a
 * span of half a million blocks costs upwards of two thousand requests, most of
 * them rejections, which then trip the rate limit that kills the replay. Five
 * probes settle the same question, and the rest of the replay is windows that
 * are known to work.
 */
async function discoverCap(client: PoolClient, pool: Address, head: bigint): Promise<bigint> {
  const cached = capCache.get(pool);
  if (cached) return cached;
  for (const cap of CAP_LADDER) {
    const from = head > cap ? head - cap : 0n;
    try {
      await client.getContractEvents({ address: pool, abi: SHIELDED_POOL_ABI, fromBlock: from, toBlock: head });
      capCache.set(pool, cap);
      return cap;
    } catch (e) {
      if (!isRangeError((e as Error).message)) throw e;
    }
  }
  throw new Error("No usable eth_getLogs window: the RPC rejected even a hundred blocks.");
}

/** One window, with a single retry so a transient does not lose the whole replay. */
async function fetchWindow(
  client: PoolClient,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PoolLog[]> {
  try {
    return (await client.getContractEvents({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      fromBlock,
      toBlock,
    })) as unknown as PoolLog[];
  } catch (e) {
    if (isRangeError((e as Error).message)) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return (await client.getContractEvents({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      fromBlock,
      toBlock,
    })) as unknown as PoolLog[];
  }
}

/**
 * getContractEvents that survives providers capping how many blocks one
 * eth_getLogs may span. The whole range goes out first — most providers serve
 * it, and on the pool's own history that is a single request. On a cap the
 * width is taken from the provider's message when it names one, probed
 * otherwise, and the range refetches in windows of that width, in small
 * concurrent groups.
 */
async function fetchPoolEvents(
  client: PoolClient,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
  atHead = false,
): Promise<PoolLog[]> {
  // Asking for "latest" rather than the head's number is not cosmetic: at least
  // one provider caps a numbered range at a thousand blocks while serving the
  // same span unbounded under the tag, which is the difference between one
  // request and six hundred. The reply can then run past the head this sync
  // pinned, so it is trimmed back — the leaf count and root are read at that
  // head, and a log that outran them would look like a pool gaining leaves
  // from nowhere.
  if (atHead) {
    try {
      const logs = (await client.getContractEvents({
        address: pool,
        abi: SHIELDED_POOL_ABI,
        fromBlock,
        toBlock: "latest",
      })) as unknown as PoolLog[];
      return logs.filter((l) => l.blockNumber === null || l.blockNumber <= toBlock);
    } catch (e) {
      if (!isRangeError((e as Error).message)) throw e;
      // Capped even under the tag — fall through to windows.
    }
  }

  try {
    return await fetchWindow(client, pool, fromBlock, toBlock);
  } catch (e) {
    const msg = (e as Error).message;
    if (!isRangeError(msg) || toBlock <= fromBlock) throw e;

    const span = toBlock - fromBlock + 1n;
    let cap = namedCap(msg) ?? (await discoverCap(client, pool, toBlock));
    if (cap < 1n || cap >= span) cap = await discoverCap(client, pool, toBlock);

    const windows: [bigint, bigint][] = [];
    for (let start = fromBlock; start <= toBlock; start += cap) {
      const end = start + cap - 1n < toBlock ? start + cap - 1n : toBlock;
      windows.push([start, end]);
    }

    return drainWindows(client, pool, windows);
  }
}

/**
 * Work through the windows, letting the provider set the pace.
 *
 * A capped provider is usually a throttled one too, and a cold replay is
 * hundreds of windows — enough that a fixed concurrency either crawls or trips
 * the limit and loses the replay outright. Refused windows go back in the queue
 * while concurrency halves and the wait doubles; clean rounds earn both back.
 * The attempt ceiling is what separates a slow provider from a broken one.
 */
async function drainWindows(
  client: PoolClient,
  pool: Address,
  windows: [bigint, bigint][],
): Promise<PoolLog[]> {
  const out: PoolLog[] = [];
  const queue = [...windows];
  let group = GROUP;
  let wait = 0;
  let refusals = 0;

  while (queue.length > 0) {
    if (wait > 0) await sleep(wait);
    const batch = queue.splice(0, group);
    const results = await Promise.allSettled(batch.map(([a, b]) => fetchWindow(client, pool, a, b)));

    const refused: [bigint, bigint][] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(...r.value);
      else refused.push(batch[i]!);
    });

    if (refused.length > 0) {
      queue.unshift(...refused);
      refusals++;
      if (refusals > 40) {
        throw new Error(
          `The RPC kept refusing the log replay (${queue.length} of ${windows.length} windows left). Try again in a minute.`,
        );
      }
      group = Math.max(1, Math.floor(group / 2));
      wait = Math.min(wait > 0 ? wait * 2 : 500, 8_000);
    } else {
      group = Math.min(GROUP, group + 1);
      wait = Math.floor(wait / 2);
    }
  }
  return out;
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
