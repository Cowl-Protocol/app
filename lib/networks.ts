import { defineChain, type Chain } from "viem";

// Mirror of the CLI's network definitions (cli/src/networks.ts), trimmed for the
// browser app. Robinhood Chain is an Arbitrum-based L2: the public testnet
// (chainId 46630) went live Feb 2026 and mainnet (chainId 4663) on Jul 1 2026.
// The shielded pool is deployed on both; the app targets mainnet by default.

export type CowlContracts = {
  pool?: `0x${string}`;
  weth?: `0x${string}`;
  usdg?: `0x${string}`;
  swapRouter?: `0x${string}`;
  quoter?: `0x${string}`;
  tradeAdapter?: `0x${string}`;
  relayer?: `0x${string}`;
};

export type NetworkDef = {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  rpcFallback?: string;
  defaultRelay?: string;
  explorer: string;
  currency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
  contracts: CowlContracts;
};

export const NETWORKS: Record<string, NetworkDef> = {
  "robinhood-testnet": {
    key: "robinhood-testnet",
    label: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://46630.rpc.thirdweb.com",
    rpcFallback: "https://rpc.testnet.chain.robinhood.com",
    defaultRelay: "https://relay.cowlprotocol.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    contracts: {
      pool: "0xf9F825f2D6d8509c78baaa587694f74672C32A59",
      weth: "0xdC155cafBa4D26790781c12e4B1001F933496Da2",
      usdg: "0xa82762eDA1AF5Ed19B9BD544C121dbcF365526aC",
      swapRouter: "0xbd610c3A708C483a64dC2C92876C2D1a8Ef43b03",
      quoter: "0x5cD1F037A2CB277A7661Ad6c045803BFC428f84B",
      tradeAdapter: "0xD0D74be38C0B99EBa6465e9F512c3F78EE2d1f3B",
    },
  },
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    rpcFallback: "https://robinhoodchain.blockscout.com/api/eth-rpc",
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: false,
    // Mainnet stack, deployed 2026-07-24 (mirror of cli/src/networks.ts).
    // Venue = the live pons Uniswap V3 (router is a SwapRouter02).
    contracts: {
      pool: "0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E",
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
      quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
      tradeAdapter: "0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98",
    },
  },
};

// Mainnet is the live network: the pool shipped there 2026-07-24 and the chain's
// tokenized assets are on it. Testnet stays one click away in the selector.
export const DEFAULT_NETWORK = "robinhood-mainnet";

const STORE_KEY = "cowl.network";

/** The network the app runs against. Persisted per browser; testnet by default. */
export function activeNetwork(): NetworkDef {
  if (typeof window !== "undefined") {
    try {
      const key = window.localStorage.getItem(STORE_KEY);
      if (key && NETWORKS[key]) return NETWORKS[key];
    } catch {
      /* storage blocked, fall through to the default */
    }
  }
  return NETWORKS[DEFAULT_NETWORK];
}

/** Switch networks and reload so every module re-derives from the new one. */
export function setActiveNetwork(key: string) {
  if (!NETWORKS[key]) return;
  try {
    window.localStorage.setItem(STORE_KEY, key);
  } catch {
    /* storage blocked, the reload just keeps the default */
  }
  window.location.reload();
}

/** Multicall3, at its canonical address on both Robinhood networks. Reads batch
 * through it so a page of balances costs one request, which keeps the public
 * endpoints comfortable. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Build a viem Chain object from a network definition. */
export function toViemChain(net: NetworkDef): Chain {
  return defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: net.currency,
    rpcUrls: {
      default: { http: [net.rpcUrl, ...(net.rpcFallback ? [net.rpcFallback] : [])] },
    },
    blockExplorers: { default: { name: net.label, url: net.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: net.testnet,
  });
}
