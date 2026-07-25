"use client";

import { publicClient } from "./useWallet";
import { rememberTokenMeta, tokenAddressForField, tokenMetaForField } from "./tokens";

const ERC20_META_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Ask the chain to name any token fields the local lists can't. Resolves what
 * it can into the persistent meta cache and reports whether anything new was
 * learned, so a caller can re-render rows that were showing a short address.
 * A contract that doesn't answer (or answers in bytes32) keeps its address
 * label — wrong decimals would misstate an amount, which is worse than an
 * unnamed row.
 */
export async function ensureTokenMeta(fields: bigint[]): Promise<boolean> {
  const unresolved = [...new Set(fields.filter((f) => f !== 0n && !tokenMetaForField(f).resolved))];
  if (unresolved.length === 0) return false;
  const results = await Promise.all(
    unresolved.map(async (field) => {
      const address = tokenAddressForField(field);
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
          publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
        ]);
        rememberTokenMeta(address, { symbol, decimals: Number(decimals) });
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}
