import { defineChain, type Chain } from "viem";

// Mirror of the CLI's network definitions (cli/src/networks.ts), trimmed for the
// browser app. Robinhood Chain is an Arbitrum-based L2: the public testnet
// (chainId 46630) went live Feb 2026 and mainnet (chainId 4663) on Jul 1 2026.
// The shielded pool is deployed on both; the app targets mainnet by default.

export type CowlContracts = {
  pool?: `0x${string}`;
  /** Block the pool deployed at — where a cold event-log replay starts. */
  poolDeployBlock?: bigint;
  weth?: `0x${string}`;
  usdg?: `0x${string}`;
  /** The protocol token, where it exists. Unset keeps it display-only. */
  cowl?: `0x${string}`;
  swapRouter?: `0x${string}`;
  quoter?: `0x${string}`;
  tradeAdapter?: `0x${string}`;
  /** Uniswap V3 fee tier the trade route uses. Unset means 3000 (0.3%). */
  feeTier?: number;
  relayer?: `0x${string}`;
};

export type NetworkDef = {
  key: string;
  label: string;
  chainId: number;
  /**
   * RPC endpoints in preference order. The first that answers a given call wins,
   * and a call it refuses falls through to the next — which is load-bearing
   * here, not just redundancy: the fast endpoints serve balances and calls but
   * refuse historical eth_getLogs, and the explorer endpoint that serves the
   * log replay would rate-limit a page of balances into failure. Between them
   * every call has a home. Browser-usable only, so every entry sends CORS.
   */
  rpcUrls: string[];
  defaultRelay?: string;
  /**
   * Gas one atomic trade needs (mirror of the CLI's NetworkDef.tradeGas). The
   * relayer prices a trade fee from this same figure, so the two sides of the
   * gas-payer choice quote from one number here too.
   */
  tradeGas?: bigint;
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
    rpcUrls: [
      "https://46630.rpc.thirdweb.com", // serves logs too, so it leads here
      "https://robinhood-sepolia-rpc.publicnode.com",
      "https://rpc.testnet.chain.robinhood.com",
    ],
    defaultRelay: "https://relay.cowlprotocol.com",
    // The test venue's V3 stand-in burns more than the real thing.
    tradeGas: 15_000_000n,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    contracts: {
      pool: "0xf9F825f2D6d8509c78baaa587694f74672C32A59",
      poolDeployBlock: 92522685n,
      weth: "0xdC155cafBa4D26790781c12e4B1001F933496Da2",
      usdg: "0xa82762eDA1AF5Ed19B9BD544C121dbcF365526aC",
      swapRouter: "0xbd610c3A708C483a64dC2C92876C2D1a8Ef43b03",
      quoter: "0x5cD1F037A2CB277A7661Ad6c045803BFC428f84B",
      tradeAdapter: "0xD7839eC2AbBCcADf77995Af633510b1A3Cdc0726",
    },
  },
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    rpcUrls: [
      // Fast, CORS-open, no rate limit worth speaking of, but it answers
      // historical eth_getLogs with a 403 — which viem treats as this
      // transport declining, so the log replay lands on the explorer below.
      "https://robinhood-rpc.publicnode.com",
      "https://robinhoodchain.blockscout.com/api/eth-rpc",
      // Robinhood's own endpoint is fastest where it answers at all; it is
      // unreachable from some regions, so it sits last rather than first.
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    // A relayer is bound to one chain at boot, so mainnet gets its own daemon
    // behind a path on the same host rather than a second DNS name. A quote
    // that comes back naming another chain or another pool is discarded.
    defaultRelay: "https://relay.cowlprotocol.com/mainnet",
    // The first real-money trade burned 8,599,108; this sits just above it.
    tradeGas: 9_000_000n,
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: false,
    // Mainnet stack, deployed 2026-07-24 (mirror of cli/src/networks.ts).
    // Venue = the live pons Uniswap V3 (router is a SwapRouter02).
    contracts: {
      pool: "0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E",
      poolDeployBlock: 18121312n,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      cowl: "0xfc7CB8A3Df69c0F658Ac5Fb1e31dE1843E04E38f",
      swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
      quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
      tradeAdapter: "0x55B0fD7EB8a9c8F54CF52b57961412FDc53fbB7D",
      // The deepest WETH/USDG pool on pons sits at 0.05%.
      feeTier: 500,
    },
  },
};

// Mainnet is the live network: the pool shipped there 2026-07-24 and the chain's
// tokenized assets are on it. Testnet stays one click away in the selector.
export const DEFAULT_NETWORK = "robinhood-mainnet";

const STORE_KEY = "cowl.network";

/** The network the app runs against. Persisted per browser; mainnet by default. */
export function activeNetwork(): NetworkDef {
  if (typeof window !== "undefined") {
    try {
      const key = window.localStorage.getItem(STORE_KEY);
      if (key && NETWORKS[key]) return NETWORKS[key];
    } catch {
      /* storage blocked, fall through to the default */
    }
    return NETWORKS[DEFAULT_NETWORK];
  }

  /* Off the browser there is no localStorage to read, so a Node harness had no way to
     aim these modules at anything but the default. That made the app's own read path
     impossible to exercise against testnet without reimplementing it, which defeats the
     point of testing it.

     Ignored entirely in a production build. Without that guard this branch also runs
     during server rendering, so a NEXT_PUBLIC_NETWORK set on the host would render the
     server on one chain while the browser read another off localStorage, and the two
     would disagree at hydration. Local tooling gets the affordance; the deployed app
     cannot be steered by an environment variable at all. */
  if (process.env.NODE_ENV !== "production") {
    const fromEnv = process.env.NEXT_PUBLIC_NETWORK;
    if (fromEnv && NETWORKS[fromEnv]) return NETWORKS[fromEnv];
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
    rpcUrls: { default: { http: net.rpcUrls } },
    blockExplorers: { default: { name: net.label, url: net.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: net.testnet,
  });
}
