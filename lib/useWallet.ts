"use client";

import { useCallback } from "react";
import { createPublicClient, fallback, http, formatUnits } from "viem";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { activeNetwork, toViemChain } from "./networks";
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

/** Read-only client used for balances, independent of any wallet. The network's
 * fallback RPC actually engages here (a bare http() only ever uses the first
 * url), which matters where the primary is geo-restricted. */
export const publicClient = createPublicClient({
  chain,
  transport: fallback([http(net.rpcUrl), ...(net.rpcFallback ? [http(net.rpcFallback)] : [])]),
});

/** Balance of `owner` for a token (native or ERC-20), formatted. */
export async function fetchBalance(owner: `0x${string}`, token: Token): Promise<string> {
  try {
    if (token.native) {
      const bal = await publicClient.getBalance({ address: owner });
      return formatUnits(bal, token.decimals);
    }
    if (/^0x0{40}$/i.test(token.address)) return "0";
    const bal = (await publicClient.readContract({
      address: token.address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    return formatUnits(bal, token.decimals);
  } catch {
    return "0";
  }
}

/**
 * Thin wrapper over wagmi + RainbowKit so the components keep a single, stable
 * wallet shape. Connecting is delegated to the themed RainbowKit modal, which
 * covers injected wallets, WalletConnect (mobile QR) and Coinbase Wallet.
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
    async (token: Token): Promise<string> => {
      if (!address) return "0";
      return fetchBalance(address, token);
    },
    [address],
  );

  return {
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
  };
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
