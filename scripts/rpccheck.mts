// Health check for the app's RPC arrangement, run against the real config:
//   npx tsx scripts/rpccheck.mts
//
// Each network's endpoint list has to cover three shapes of call between them:
// a burst of balances (what a page load fires), reads pinned to the head block
// (what a pool sync does), and a full historical getLogs replay (what a cold
// sync does). Any of the three failing is what a screen of zeros looks like.
import { createPublicClient, formatUnits } from "viem";
import { NETWORKS, toViemChain } from "../lib/networks";
import { transportFor } from "../lib/transport";
import { fetchLeaves, SHIELDED_POOL_ABI } from "../lib/shielded/contract";

const PROBE_WALLET = "0x0f02AdCB7d6d8871ad9555A7f0d90F5faE69A7a6" as const;

let failures = 0;
function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(22)} ${detail}`);
  if (!ok) failures++;
}

for (const net of Object.values(NETWORKS)) {
  console.log(`\n${net.label} (${net.chainId})`);
  console.log(`  endpoints: ${net.rpcUrls.join(", ")}`);
  const client = createPublicClient({
    chain: toViemChain(net),
    transport: transportFor(net),
    batch: { multicall: { wait: 24 } },
  });

  let head = 0n;
  try {
    const t = Date.now();
    head = await client.getBlockNumber();
    report("head block", true, `${head} in ${Date.now() - t}ms`);
  } catch (e) {
    report("head block", false, (e as Error).message.split("\n")[0]!);
    continue;
  }

  try {
    const t = Date.now();
    const many = await Promise.all(
      Array.from({ length: 8 }, () => client.getBalance({ address: PROBE_WALLET })),
    );
    const same = new Set(many.map(String)).size === 1;
    report("burst of 8 balances", same, `${formatUnits(many[0]!, 18)} ETH in ${Date.now() - t}ms`);
  } catch (e) {
    report("burst of 8 balances", false, (e as Error).message.split("\n")[0]!);
  }

  const pool = net.contracts.pool;
  if (!pool) continue;

  try {
    const t = Date.now();
    const [root, leaves] = await Promise.all([
      client.readContract({ address: pool, abi: SHIELDED_POOL_ABI, functionName: "root", blockNumber: head }),
      client.readContract({ address: pool, abi: SHIELDED_POOL_ABI, functionName: "nextLeafIndex", blockNumber: head }),
    ]);
    report("reads at head block", true, `${leaves} leaves, root ${String(root).slice(0, 12)}… in ${Date.now() - t}ms`);
  } catch (e) {
    report("reads at head block", false, (e as Error).message.split("\n")[0]!);
  }

  // Through the app's own path, so the range-cap chunking is under test too.
  try {
    const t = Date.now();
    const chain = await fetchLeaves(net, net.contracts.poolDeployBlock ?? 0n, client);
    report(
      "full log replay",
      chain.leaves.length === chain.totalLeaves,
      `${chain.leaves.length}/${chain.totalLeaves} leaves, ${chain.nullifiers.length} nullifiers in ${Date.now() - t}ms`,
    );
  } catch (e) {
    report("full log replay", false, (e as Error).message.split("\n")[0]!);
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
