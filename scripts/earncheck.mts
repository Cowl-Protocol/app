// Earn read path, against the real testnet rehearsal. Run with:
//   npx tsx scripts/earncheck.mts
//   EARNCHECK_ALLOCATION=/path/to/allocation.json npx tsx scripts/earncheck.mts
//
// The rehearsal lives on Robinhood Chain testnet (46630): `earn/contracts/cycle-testnet.sh`
// deployed mocks and a fresh CowlEarn, collected fees, published a root and claimed
// against it. That contract is still there, still holding a root, so the whole claim path
// can be exercised for free and forever without sending anything.
//
// What this proves that the forge tests cannot
// ────────────────────────────────────────────
// The tests build their leaves in Solidity, and so did the cycle script. So the tree the
// *indexer* builds — `earn/lib/merkle.mjs`, the code that decides who gets paid on
// mainnet — had never once been shown to agree with the verifier on a chain. This
// rebuilds the live allocation with that builder and checks two things the tests
// structurally cannot:
//
//   1. the root it computes is byte for byte the root CowlEarn is verifying against
//   2. a proof it generates is ACCEPTED by that verifier, in a real eth_call
//
// Nothing here broadcasts. The claim checks are `eth_call` simulations, and the refusal
// case leans on the contract's own ordering: `InvalidProof` is thrown before
// `NothingToClaim`, so an already-paid address refused with the latter is positive
// evidence that the proof itself passed.
//
// Which allocation
// ────────────────
// Whatever the contract currently holds a root for. The built-in default is the two leaf
// set the cycle script published; any later root was published from a set this file
// cannot know, so point `EARNCHECK_ALLOCATION` at a JSON array of
// `{ address, cumCowl, cumWeth }` and the root check will tell you immediately whether
// it is the right one. A guessed set cannot pass — that is the whole point of check 1.
//
// The set is deliberately not hardcoded beyond the rehearsal's own two addresses. Later
// roots exist to give a real wallet something to claim in the UI, and a wallet somebody
// actually uses does not belong in a public repository.
//
// The allocation is served from a throwaway local server rather than written into
// `earn/roots/`. That directory is the published mainnet evidence; a synthetic testnet
// artifact sitting in it could be mistaken for the real thing, and nothing here needs it
// to survive the process.
import { encodeFunctionData, getAddress, toFunctionSelector, type Address } from "viem";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

// The indexer's own merkle builder — the point of the exercise, not a convenience.
import { buildTree, getProof, leafHash, verifyProof } from "../../earn/lib/merkle.mjs";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

/* ── the rehearsal, mirrored from earn/contracts/script/TestnetCycle.s.sol ────── */
const EARN_TESTNET = getAddress("0x4c83986db6842fbc859983d02701ac736caf0b50");

/* The contract's own view of what an address may still take. The app has no reason to
   call these — it already holds both numbers — but a check does: it turns "the reader
   agrees with itself" into "the reader agrees with the contract". */
const CLAIMABLE_ABI = [
  {
    type: "function",
    name: "claimableCowl",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimableWeth",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

type Entry = { address: Address; cumCowl: bigint; cumWeth: bigint };

const REHEARSAL: Entry[] = [
  // cowl-deployer, the cycle's sender — it claimed its full entitlement during the run.
  { address: getAddress("0xd5f69bcf5969f827981296ba1c417ca2456b2eff"), cumCowl: 300n * 10n ** 18n, cumWeth: 600n * 10n ** 12n },
  // The second leaf, so a proof is a real sibling rather than an empty array.
  { address: getAddress("0x000000000000000000000000000000000000dead"), cumCowl: 100n * 10n ** 18n, cumWeth: 200n * 10n ** 12n },
];

const allocationPath = process.env.EARNCHECK_ALLOCATION;
const allocation: Entry[] = allocationPath
  ? (JSON.parse(readFileSync(allocationPath, "utf8")) as { address: string; cumCowl: string; cumWeth: string }[]).map(
      (e) => ({ address: getAddress(e.address), cumCowl: BigInt(e.cumCowl), cumWeth: BigInt(e.cumWeth) }),
    )
  : REHEARSAL;

/* ── 1. rebuild the allocation with the indexer's builder ──────────────────── */
const leaves = new Map(allocation.map((e) => [e.address, leafHash(e.address, e.cumCowl, e.cumWeth)] as const));
const tree = buildTree([...leaves.values()]);
const proofs = new Map([...leaves].map(([who, leaf]) => [who, getProof(tree, leaf)] as const));

check(
  "proofs verify locally (every leaf)",
  allocation.every((e) => verifyProof(leaves.get(e.address)!, proofs.get(e.address)!, tree.root)),
  `${allocation.length} leaves${allocationPath ? ` from ${allocationPath}` : " (built-in rehearsal set)"}`,
);

/* ── 2. serve the allocation the way the app expects to find it ────────────────
   Mutable on purpose: the stale case below rewrites what is served rather than
   re-importing the reader, since `readEarn` fetches with `cache: no-store` and so sees
   the change on the very next call. */
type Shard = { root: string; claims: Record<string, { cumCowl: string; cumWeth: string; proof: string[] }> };
let served: Record<string, Shard> = {};

function publish(root: string) {
  served = {};
  for (const e of allocation) {
    const key = earnKey(e.address);
    const shard = key.slice(2, 4);
    served[shard] ??= { root, claims: {} };
    served[shard].claims[key] = {
      cumCowl: e.cumCowl.toString(),
      cumWeth: e.cumWeth.toString(),
      proof: proofs.get(e.address)!,
    };
  }
}

const server = createServer((req, res) => {
  const shard = /\/shards\/([0-9a-f]{2})\.json$/.exec(req.url ?? "")?.[1];
  const body = shard ? served[shard] : undefined;
  // A missing shard is a 404 on the real host too — that is how "this address was never
  // paid" reaches the reader, so it must not be an error here either.
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

/* ── 3. point the app's own modules at the rehearsal ───────────────────────────
   Both modules read their configuration once, at import, exactly as they do in the
   browser. So the environment has to be set before the import rather than after, and the
   import has to be dynamic for that to be possible. */
process.env.NEXT_PUBLIC_NETWORK ??= "robinhood-testnet";
// Overridable only through a name of this file's own, so a stray NEXT_PUBLIC_EARN_ADDRESS
// in the shell cannot quietly point these checks at a different contract. The children
// below are the only callers that set it.
process.env.NEXT_PUBLIC_EARN_ADDRESS = process.env.EARNCHECK_ADDRESS ?? EARN_TESTNET;
process.env.NEXT_PUBLIC_EARN_ROOTS_BASE = `http://127.0.0.1:${port}`;

const { readEarn, buildClaim, earnKey, EARN_ABI } = await import("../lib/earn");
const { publicClient } = await import("../lib/rpc");

/* The misconfiguration cases, answered here because they cannot be answered anywhere
   else. Both the network and the contract address are read once at import — `lib/rpc`
   binds its chain there, `lib/earn` validates its address there — so asking what the
   reader does with a different one means a different process. The parent spawns them at
   the bottom of this file. Everything below assumes a working testnet configuration and
   would simply fail, so a child answers its one question and leaves. */
if (process.env.EARNCHECK_CHILD) {
  const s = await readEarn(REHEARSAL[0].address);
  console.log(`STATE:${s.state}`);
  server.close();
  process.exit(0);
}

check("app is pointed at testnet 46630", publicClient.chain?.id === 46630, `chain ${publicClient.chain?.id}`);

/* ── 4. the parity that matters: the indexer's tree === the root on chain ───── */
const chainRoot = (await publicClient.readContract({
  address: EARN_TESTNET,
  abi: EARN_ABI,
  functionName: "root",
})) as `0x${string}`;

const rootMatches = tree.root.toLowerCase() === chainRoot.toLowerCase();
check(
  "indexer's merkle root === the root CowlEarn holds",
  rootMatches,
  rootMatches ? `${tree.root.slice(0, 14)}…` : `built ${tree.root.slice(0, 14)}… but chain holds ${chainRoot.slice(0, 14)}…`,
);

if (!rootMatches) {
  console.log(
    "\nThe contract is verifying against a root this allocation does not produce, so every\n" +
      "figure below would be meaningless. A later setRoot was published from a set this file\n" +
      "was not given: pass EARNCHECK_ALLOCATION pointing at it.\n",
  );
  server.close();
  process.exit(1);
}

publish(chainRoot);

/* ── 5. the reader, against real chain state ───────────────────────────────────
   Nothing is asserted about *which* addresses still have something to claim. That is
   chain state, it changes the moment somebody claims, and a check that has to be edited
   after every claim would be edited into agreement rather than believed. What is asserted
   is that the reader's arithmetic matches the contract's own view. */
const owed: Entry[] = [];
const settled: Entry[] = [];

for (const e of allocation) {
  const s = await readEarn(e.address);
  const label = `${e.address.slice(0, 10)}…`;
  check(`${label} resolves to ready`, s.state === "ready", s.state);
  if (s.state !== "ready") continue;

  check(`${label} cumulative matches the published allocation`, s.cumCowl === e.cumCowl && s.cumWeth === e.cumWeth);

  // `claimableCowl(address,uint256)` is the contract's own answer to the same question,
  // so this pins the reader against the source of truth rather than against itself.
  const [onChainCowl, onChainWeth] = (await Promise.all([
    publicClient.readContract({
      address: EARN_TESTNET,
      abi: CLAIMABLE_ABI,
      functionName: "claimableCowl",
      args: [e.address, e.cumCowl],
    }),
    publicClient.readContract({
      address: EARN_TESTNET,
      abi: CLAIMABLE_ABI,
      functionName: "claimableWeth",
      args: [e.address, e.cumWeth],
    }),
  ])) as [bigint, bigint];

  check(
    `${label} claimable agrees with the contract`,
    s.claimableCowl === onChainCowl && s.claimableWeth === onChainWeth,
    `${s.claimableCowl / 10n ** 18n} COWL owed, ${s.claimedCowl / 10n ** 18n} already taken`,
  );

  (s.claimableCowl > 0n || s.claimableWeth > 0n ? owed : settled).push(e);
}

/* ── 6. the chain's verdict on a proof this file built ─────────────────────── */
const INVALID_PROOF = toFunctionSelector("InvalidProof()");
const NOTHING_TO_CLAIM = toFunctionSelector("NothingToClaim()");

/* The app's ABI carries no error definitions, so viem cannot name the revert — it
   surfaces the raw four bytes instead, somewhere down the cause chain. Matching on that
   selector is exact; matching on a message would be a guess about wording. */
function revertData(err: unknown): string {
  let e: unknown = err;
  const seen = new Set<unknown>();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return data;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") {
      return (data as { data: string }).data;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return err instanceof Error ? err.message : String(err);
}

async function simulateClaim(e: Entry) {
  const status = await readEarn(e.address);
  if (status.state !== "ready") throw new Error(`expected ready, got ${status.state}`);
  const call = buildClaim(status);
  try {
    await publicClient.call({
      account: e.address,
      to: EARN_TESTNET,
      data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as never }),
    });
    return { ok: true, revert: "" };
  } catch (err) {
    return { ok: false, revert: revertData(err) };
  }
}

if (owed.length) {
  const e = owed[0];
  const r = await simulateClaim(e);
  check(
    "CowlEarn ACCEPTS a proof built by the indexer (simulated claim succeeds)",
    r.ok,
    r.ok ? `${e.cumCowl / 10n ** 18n} COWL would pay out to ${e.address.slice(0, 10)}…` : r.revert.slice(0, 120),
  );
} else {
  check("CowlEarn ACCEPTS a proof built by the indexer", false, "nothing left unclaimed to simulate against");
}

if (settled.length) {
  const r = await simulateClaim(settled[0]);
  const nothing = r.revert.includes(NOTHING_TO_CLAIM.slice(2));
  const invalid = r.revert.includes(INVALID_PROOF.slice(2));
  check(
    "an already-paid address is refused for the right reason",
    !r.ok && nothing && !invalid,
    nothing ? "NothingToClaim — which is thrown after the proof check, so the proof passed" : r.revert.slice(0, 120),
  );
} else {
  console.log("SKIP  already-paid refusal — every address in this allocation still has something owed");
}

/* ── 7. the states that exist to catch a mistake ───────────────────────────── */
{
  // Nobody has an entry here, so no shard is served for it.
  const s = await readEarn(getAddress("0x00000000000000000000000000000000000000a1"));
  check("an address with no allocation resolves to none", s.state === "none", s.state);
}

{
  publish("0x" + "ff".repeat(32)); // a file the contract is not verifying against
  const s = await readEarn(allocation[0].address);
  check("a file disagreeing with the chain is refused, not shown", s.state === "stale", s.state);
  publish(chainRoot);
}

server.close();

/* ── 8. the misconfigurations, in their own processes ──────────────────────────
   Both are worth an hour when they go wrong, because both used to surface as something
   that reads like a hiccup — and a hiccup invites waiting, which never helps. Each child
   runs the branch installed just after the imports above and reports the state it got. */
{
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const self = resolve(process.argv[1]);

  function childState(env: Record<string, string>): string {
    try {
      const out = execFileSync(process.execPath, ["--import", "tsx", self], {
        env: { ...process.env, EARNCHECK_CHILD: "1", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return /STATE:(\S+)/.exec(out)?.[1] ?? "(no state reported)";
    } catch (err) {
      return `child run failed: ${err}`;
    }
  }

  const onMainnet = childState({ NEXT_PUBLIC_NETWORK: "robinhood-mainnet" });
  check("a testnet address read on mainnet reports wrong-network", onMainnet === "wrong-network", onMainnet);

  /* The exact paste that cost a debugging round: the right contract, in the casing a
     deploy log printed it in. EIP-55 says that is a different string, and the reader has
     to name it rather than let it fail deep inside the first call. */
  const badChecksum = childState({ EARNCHECK_ADDRESS: "0x4c83986dB6842fBC859983D02701AC736CAf0b50" });
  check("an address with a broken checksum reports misconfigured", badChecksum === "misconfigured", badChecksum);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
