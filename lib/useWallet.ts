"use client";

import { useCallback, useMemo } from "react";
import { createPublicClient, formatUnits } from "viem";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { activeNetwork, toViemChain } from "./networks";
import { transportFor } from "./transport";
import type { Token } from "./tokens";

const net = activeNetwork();
const chain = toViemChain(net);

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Read-only client used for balances, independent of any wallet. */
export const publicClient = createPublicClient({
  chain,
  transport: transportFor(net),
  // Concurrent contract reads collapse into a single multicall, so a page of
  // balances costs one request rather than one per token.
  batch: { multicall: { wait: 24 } },
});

/**
 * Balance of `owner` for a token, in base units.
 *
 * Throws when the read fails. That is deliberate: an earlier version answered
 * an unreachable endpoint with zero, and a confident zero is the one wrong
 * answer a balance must never give — it reads as "your funds are gone" and, on
 * the shielded side, would invite a second deposit of money already deposited.
 * Callers render the failure instead.
 */
export async function fetchBalance(owner: `0x${string}`, token: Token): Promise<bigint> {
  if (token.native) return publicClient.getBalance({ address: owner });
  if (/^0x0{40}$/i.test(token.address)) return 0n;
  return publicClient.readContract({
    address: token.address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  }) as Promise<bigint>;
}

/** Formatted balance, or null when the read failed. */
export async function fetchBalanceFormatted(owner: `0x${string}`, token: Token): Promise<string | null> {
  try {
    return formatUnits(await fetchBalance(owner, token), token.decimals);
  } catch {
    return null;
  }
}

/**
 * Thin wrapper over wagmi + RainbowKit so the components keep a single, stable
 * wallet shape. The returned object is memoised on the values that actually
 * change — components key effects off it, and a fresh object every render used
 * to re-fire every balance read on every render, which turned into a burst of
 * requests and, against a rate-limited endpoint, a screen full of zeros.
 */
export function useWallet() {
  const { address, chainId, isConnecting } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const wrongNetwork = !!address && chainId !== undefined && chainId !== net.chainId;

  const connect = useCallback(() => {
    openConnectModal?.();
  }, [openConnectModal]);

  const switchNetwork = useCallback(() => {
    switchChain({ chainId: net.chainId });
  }, [switchChain]);

  const getBalance = useCallback(
    async (token: Token): Promise<string | null> => {
      if (!address) return "0";
      return fetchBalanceFormatted(address, token);
    },
    [address],
  );

  return useMemo(
    () => ({
      address: address ?? null,
      chainId: chainId ?? null,
      connecting: isConnecting,
      // RainbowKit's modal handles the no-wallet case (shows install options).
      hasWallet: true,
      wrongNetwork,
      connect,
      disconnect,
      switchNetwork,
      getBalance,
      network: net,
    }),
    [address, chainId, isConnecting, wrongNetwork, connect, disconnect, switchNetwork, getBalance],
  );
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
