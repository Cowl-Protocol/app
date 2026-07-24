import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  walletConnectWallet,
  rainbowWallet,
  coinbaseWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { NETWORKS, toViemChain } from "./networks";
import { transportFor } from "./transport";

// RainbowKit needs a WalletConnect Cloud projectId (free, cloud.reown.com) to enable
// mobile / QR connections. Drop it into .env.local as NEXT_PUBLIC_WC_PROJECT_ID; a
// placeholder keeps injected (MetaMask/Rabby) wallets working until the real id lands.
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "PLACEHOLDER_WC_PROJECT_ID";

const testnet = toViemChain(NETWORKS["robinhood-testnet"]);
const mainnet = toViemChain(NETWORKS["robinhood-mainnet"]);

// Curated connector list — deliberately NOT getDefaultConfig, whose default set now
// bundles the Base Account wallet (pulls @coinbase/cdp-sdk → @x402/*, uninstalled and
// breaks the SSR build). This covers the wallets that matter without that weight.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [injectedWallet, metaMaskWallet, rainbowWallet, coinbaseWallet, walletConnectWallet],
    },
  ],
  { appName: "Cowl", projectId },
);

export const wagmiConfig = createConfig({
  connectors,
  // Both networks are live; the app's active one comes from the network selector.
  chains: [testnet, mainnet],
  transports: {
    [testnet.id]: transportFor(NETWORKS["robinhood-testnet"]),
    [mainnet.id]: transportFor(NETWORKS["robinhood-mainnet"]),
  },
  ssr: true,
});
