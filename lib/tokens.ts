import { activeNetwork } from "./networks";

export type Token = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  /** Native gas token (no ERC-20 address; balanceOf via getBalance). */
  native?: boolean;
  /** Self-hosted token icon under /public/tokens, or the explorer's icon for listed tokens. */
  logoURI?: string;
  /** Holder count from the explorer, for tokens that came off the live list. */
  holders?: number;
  /** USD price from the explorer, for tokens that came off the live list. */
  priceUsd?: number;
};

const net = activeNetwork();

// The trade venue on the testnet is a V3-interface stand-in with WETH/USDG.
// $COWL is listed as the protocol token; its trade route lands when the pool
// pair is live, so it stays selectable but quotes as indicative.
export const TOKENS: Token[] = [
  {
    symbol: "ETH",
    name: "Ether",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    native: true,
    logoURI: "/tokens/eth.svg",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: net.contracts.weth ?? "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/weth.png",
  },
  {
    symbol: "USDG",
    name: "USD Gold",
    address: net.contracts.usdg ?? "0x0000000000000000000000000000000000000000",
    decimals: 6,
    logoURI: "/tokens/usdg.png",
  },
  {
    symbol: "COWL",
    name: "Cowl Protocol",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/cowl.png",
  },
];

export function tokenBySymbol(symbol: string): Token {
  return TOKENS.find((t) => t.symbol === symbol) ?? TOKENS[0];
}
