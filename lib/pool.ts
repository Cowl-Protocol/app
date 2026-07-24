"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "./networks";
import { publicClient } from "./useWallet";
import { tokenBySymbol } from "./tokens";

// Read-only view over the shielded pool contract — the numbers anyone can see.
// What the pool holds and how many notes it carries are public; who owns which
// note is not, and that split is the whole product.

const net = activeNetwork();

const POOL_VIEW_ABI = [
  { type: "function", name: "nextLeafIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type PoolStats = {
  /** Pooled native coin, formatted. */
  eth: string;
  /** Pooled USDG, formatted. */
  usdg: string;
  /** Notes in the tree (nextLeafIndex). */
  notes: number;
  /** Current Merkle root. */
  root: string;
};

export async function fetchPoolStats(): Promise<PoolStats | null> {
  const pool = net.contracts.pool;
  if (!pool) return null;
  const usdg = tokenBySymbol("USDG");
  const [bal, notes, root, usdgBal] = await Promise.all([
    publicClient.getBalance({ address: pool }),
    publicClient.readContract({ address: pool, abi: POOL_VIEW_ABI, functionName: "nextLeafIndex" }),
    publicClient.readContract({ address: pool, abi: POOL_VIEW_ABI, functionName: "root" }),
    net.contracts.usdg
      ? publicClient.readContract({
          address: net.contracts.usdg,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [pool],
        })
      : Promise.resolve(0n),
  ]);
  return {
    eth: formatUnits(bal, 18),
    usdg: formatUnits(usdgBal as bigint, usdg.decimals),
    notes: Number(notes),
    root: root as string,
  };
}

/** Live pool stats, fetched on mount; null while loading or if no pool is deployed. */
export function usePoolStats(): PoolStats | null {
  const [stats, setStats] = useState<PoolStats | null>(null);
  useEffect(() => {
    let alive = true;
    fetchPoolStats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return stats;
}
