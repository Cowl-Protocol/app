"use client";

// Brings the browser's shielded pool in step with the chain — the port of
// cli/src/shielded/sync.ts over localStorage state.
//
// The happy path is cheap: resume the NoteCommitted replay from the stored
// cursor block, append whatever is new, advance the cursor. When the local log
// disagrees with the chain the incremental pass throws ChainDrift and the whole
// history replays once from the deploy block, keeping ciphertexts by commitment.
import { activeNetwork } from "../networks";
import { fetchLeaves, poolAddress } from "./contract";
import { ChainDrift, alignPoolToChain, applyChainLeaves, type Pool } from "./pool";
import { loadPool, savePool } from "./store";

export type SyncResult = {
  appended: number;
  totalLeaves: number;
  root: string;
  resynced: boolean;
  pool: Pool;
};

/** Sync the local pool with the on-chain one; null where no pool is deployed. */
export async function syncShieldedPool(opts: { full?: boolean } = {}): Promise<SyncResult | null> {
  const net = activeNetwork();
  if (!poolAddress(net)) return null;
  const deployBlock = net.contracts.poolDeployBlock ?? 0n;
  const pool = loadPool(net.key);
  const before = pool.commitments.length;

  let resynced = false;
  if (opts.full) {
    resynced = await replayEverything(pool, deployBlock);
  } else {
    const from = pool.syncedBlock !== undefined ? BigInt(pool.syncedBlock) + 1n : deployBlock;
    try {
      const chain = await fetchLeaves(net, from);
      applyChainLeaves(pool, chain.leaves, chain.nullifiers, chain.totalLeaves, chain.root);
      pool.syncedBlock = chain.latestBlock.toString();
    } catch (e) {
      if (!(e instanceof ChainDrift)) throw e;
      resynced = true;
      await replayEverything(pool, deployBlock);
    }
  }

  savePool(net.key, pool);
  return {
    appended: Math.max(0, pool.commitments.length - before),
    totalLeaves: pool.commitments.length,
    root: pool.root,
    resynced,
    pool,
  };
}

/** Replace the local log with a complete replay of the chain's. */
async function replayEverything(pool: Pool, deployBlock: bigint): Promise<boolean> {
  const net = activeNetwork();
  const beforeCommitments = pool.commitments.join(",");
  const all = await fetchLeaves(net, deployBlock);
  const commitments: string[] = [];
  for (const leaf of all.leaves) commitments[leaf.index] = leaf.commitment;
  if (commitments.length !== all.totalLeaves || commitments.some((c) => !c)) {
    // Names the likely cause rather than the first suspect. Reads and logs come
    // from different endpoints, and the one serving history indexes a few
    // blocks behind, so a leaf that landed seconds ago can be real on chain and
    // absent from the log. fetchLeaves already waits for that; reaching here
    // means it stayed short.
    throw new Error(
      `The chain reports ${all.totalLeaves} notes but only ${commitments.length} are in the log yet. ` +
        `Give the explorer a moment to catch up and try again.`,
    );
  }
  alignPoolToChain(pool, all.leaves, all.nullifiers);
  if (pool.root !== all.root) {
    throw new Error(
      `Replayed ${all.totalLeaves} notes and reached root ${pool.root}, but the chain reports ${all.root}. ` +
        `The log this was rebuilt from is incomplete.`,
    );
  }
  pool.syncedBlock = all.latestBlock.toString();
  return pool.commitments.join(",") !== beforeCommitments;
}
