// Earn claim wiring.
//
// The whole point of this file is how little it does. Every heavy question — who
// traded, who shielded, what anyone is owed — was answered days earlier by the
// offline indexer, so the browser only looks its own address up and reads two
// numbers off the chain. It scans nothing.
//
// There is no backend. The allocation is a static file in a public repository and the
// contract is on chain, so a claim never waits on a server of ours. The honest limit:
// the file is hosted, so it is not beyond reach the way the contract is. What makes
// that survivable is that the repository also carries the raw archive the file was
// built from, so anyone can regenerate an identical copy and host it, and the root on
// chain says whether their copy is the right one.
//
// The file is never trusted. Its root is compared against the root the contract
// holds, and a mismatch is surfaced rather than papered over: a stale or edited file
// is caught here, and a forged proof would be refused on chain anyway.
//
// Entries are keyed by keccak256(address) rather than by a readable address. Treat
// that as tidiness, not privacy: an address is a small, public candidate space, so
// hashing the known COWL trader set and matching recovers every key in milliseconds.
// It stops a casual reader, nothing more. It does not need to do more, because the
// facts underneath were already public — the trade is in the pool's logs and the
// shield deposit is a plain transaction. What stays genuinely hidden is what the
// shielded pool hides: balances inside it, and who paid whom.
import { keccak256, encodePacked, isAddress, type Address } from "viem";

import { publicClient } from "./rpc";

/** Where the signed allocation lives. A repository rather than this app, so
 *  publishing a root is a commit and never a redeploy. */
export const EARN_ROOTS_BASE =
  process.env.NEXT_PUBLIC_EARN_ROOTS_BASE ??
  "https://raw.githubusercontent.com/Cowl-Protocol/earn/main/roots";

/** Set once CowlEarn is deployed. Absent means the programme is not wired yet. */
const configuredAddress = process.env.NEXT_PUBLIC_EARN_ADDRESS;

/**
 * Checked rather than trusted, and the checksum is not optional.
 *
 * Addresses reach this variable by being copied — out of a deploy log, a broadcast
 * file, an explorer — and every one of those prints its own casing. viem refuses an
 * address whose checksum does not match, which is correct and is the point of EIP-55,
 * but it refuses it deep inside the first call: a bad case here surfaced as "could not
 * read your share, try again in a moment", which is a suggestion that can never work.
 *
 * So the mistake is named here instead, once, where it can say what it actually is.
 * Normalising it away would be worse than the error: a typo would then silently point
 * the claim path at a contract nobody meant.
 */
export const EARN_ADDRESS: Address | undefined =
  configuredAddress && isAddress(configuredAddress) ? configuredAddress : undefined;

const EARN_ADDRESS_INVALID = !!configuredAddress && !EARN_ADDRESS;

export const EARN_ABI = [
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "claimedCowl",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimedWeth",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32[]" }],
    outputs: [],
  },
] as const;

export type ClaimEntry = {
  cumCowl: string;
  cumWeth: string;
  proof: `0x${string}`[];
};

export type EarnStatus =
  /** Not deployed, or no root published yet. */
  | { state: "not-live" }
  /** `NEXT_PUBLIC_EARN_ADDRESS` is set to something that is not an address. Nothing
   *  about this improves by waiting, so it must not read like a hiccup. */
  | { state: "misconfigured"; detail: string }
  /** The address has never traded COWL while being a pool user. */
  | { state: "none" }
  /** The published file disagrees with the chain, so no figure here is safe to show. */
  | { state: "stale"; fileRoot: `0x${string}`; chainRoot: `0x${string}` }
  /** There is no contract at EARN_ADDRESS on the network the app is pointed at. A
   *  configuration mistake, not a hiccup, and worth saying so: "try again in a moment"
   *  suggests a fix that will never work. */
  | { state: "wrong-network"; chainId: number; address: Address }
  | {
      state: "ready";
      /** Everything ever earned, per the active root. */
      cumCowl: bigint;
      cumWeth: bigint;
      /** Already taken, read from the contract. */
      claimedCowl: bigint;
      claimedWeth: bigint;
      /** What a claim right now would pay. */
      claimableCowl: bigint;
      claimableWeth: bigint;
      proof: `0x${string}`[];
    };

/** The key the indexer used, derived the same way from the connected address. */
export function earnKey(address: Address): `0x${string}` {
  return keccak256(encodePacked(["address"], [address]));
}

/** Which shard holds an address. 256 files, so a browser downloads 1/256th. */
export function shardFor(address: Address): string {
  return earnKey(address).slice(2, 4);
}

async function fetchShard(address: Address): Promise<{ root: `0x${string}`; claims: Record<string, ClaimEntry> } | null> {
  const res = await fetch(`${EARN_ROOTS_BASE}/shards/${shardFor(address)}.json`, { cache: "no-store" });
  // A missing shard is the normal answer for an address nobody has ever paid.
  if (!res.ok) return null;
  return res.json();
}

/**
 * Read what an address can claim.
 *
 * Two network calls: one static file, and one batched contract read. No scanning,
 * no indexing, no API.
 */
export async function readEarn(address: Address): Promise<EarnStatus> {
  if (EARN_ADDRESS_INVALID) {
    return { state: "misconfigured", detail: `NEXT_PUBLIC_EARN_ADDRESS is not a valid address: ${configuredAddress}` };
  }
  if (!EARN_ADDRESS) return { state: "not-live" };

  let chainRoot: `0x${string}`;
  let claimedCowl: bigint;
  let claimedWeth: bigint;
  try {
    [chainRoot, claimedCowl, claimedWeth] = await Promise.all([
      publicClient.readContract({ address: EARN_ADDRESS, abi: EARN_ABI, functionName: "root" }),
      publicClient.readContract({
        address: EARN_ADDRESS,
        abi: EARN_ABI,
        functionName: "claimedCowl",
        args: [address],
      }),
      publicClient.readContract({
        address: EARN_ADDRESS,
        abi: EARN_ABI,
        functionName: "claimedWeth",
        args: [address],
      }),
    ]);
  } catch (err) {
    /* A read against an address with no code reverts, and the raw failure reads like a
       network blip. It usually is not: it means the app is pointed at one chain and
       EARN_ADDRESS lives on another, which is exactly the mistake that costs an hour
       because the message sends you looking in the wrong place. The extra call only
       happens on the failure path, so the happy path is unchanged. */
    const code = await publicClient.getCode({ address: EARN_ADDRESS }).catch(() => undefined);
    if (!code || code === "0x") {
      return { state: "wrong-network", chainId: publicClient.chain?.id ?? 0, address: EARN_ADDRESS };
    }
    throw err;
  }

  if (!chainRoot || /^0x0+$/.test(chainRoot)) return { state: "not-live" };

  const shard = await fetchShard(address);
  if (!shard) return { state: "none" };

  // The file has no authority. If its root is not the one the contract is verifying
  // against, every figure inside it is meaningless and saying so is the only honest
  // move.
  if (shard.root.toLowerCase() !== chainRoot.toLowerCase()) {
    return { state: "stale", fileRoot: shard.root, chainRoot };
  }

  const entry = shard.claims[earnKey(address)];
  if (!entry) return { state: "none" };

  const cumCowl = BigInt(entry.cumCowl);
  const cumWeth = BigInt(entry.cumWeth);

  return {
    state: "ready",
    cumCowl,
    cumWeth,
    claimedCowl,
    claimedWeth,
    claimableCowl: cumCowl > claimedCowl ? cumCowl - claimedCowl : 0n,
    claimableWeth: cumWeth > claimedWeth ? cumWeth - claimedWeth : 0n,
    proof: entry.proof,
  };
}

/**
 * The claim transaction, ready to send from the user's own wallet.
 *
 * The user pays their own gas, deliberately. There is no relayer and no sponsored
 * path here, and none is needed: the WETH half of the rebate is unwrapped by the
 * contract and forwarded as native ETH, so the payout arrives carrying the gas it
 * cost to collect.
 */
export function buildClaim(status: Extract<EarnStatus, { state: "ready" }>) {
  if (!EARN_ADDRESS) throw new Error("Earn is not deployed on this network");
  return {
    address: EARN_ADDRESS,
    abi: EARN_ABI,
    functionName: "claim" as const,
    args: [status.cumCowl, status.cumWeth, status.proof] as const,
  };
}
