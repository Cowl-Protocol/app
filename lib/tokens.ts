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

/**
 * Symbols and decimals learned from the chain for tokens nobody curated or
 * imported — someone can be paid privately in any ERC-20, so the book has to
 * name tokens the app has never been told about. Persisted so the name
 * survives reloads and the lookup happens once per token, not once per visit.
 */
const META_CACHE_KEY = "cowl.tokenMetaCache";

function metaCache(): Record<string, { symbol: string; decimals: number }> {
  try {
    const raw = window.localStorage.getItem(META_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { symbol: string; decimals: number }>) : {};
  } catch {
    return {};
  }
}

export function rememberTokenMeta(address: `0x${string}`, meta: { symbol: string; decimals: number }) {
  try {
    const cache = metaCache();
    cache[address.toLowerCase()] = meta;
    window.localStorage.setItem(META_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked — the session still holds the resolved meta upstream */
  }
}

/** The ERC-20 address a non-native pool token field encodes. */
export function tokenAddressForField(field: bigint): `0x${string}` {
  return `0x${field.toString(16).padStart(40, "0")}` as `0x${string}`;
}

/**
 * Resolve a pool token field (0 = native, else the ERC-20 address) back to a
 * display symbol and decimals. Falls back through the user's imported tokens,
 * then metadata previously read off the chain, then to a short address at 18
 * decimals for a token whose contract hasn't answered yet.
 */
export function tokenMetaForField(field: bigint): { symbol: string; decimals: number; resolved: boolean } {
  if (field === 0n) return { symbol: net.currency.symbol, decimals: net.currency.decimals, resolved: true };
  const listed = TOKENS.find((t) => !t.native && !/^0x0{40}$/i.test(t.address) && BigInt(t.address) === field);
  if (listed) return { symbol: listed.symbol, decimals: listed.decimals, resolved: true };
  try {
    const raw = window.localStorage.getItem("cowl.importedTokens");
    const imported = raw ? (JSON.parse(raw) as Token[]) : [];
    const hit = imported.find((t) => BigInt(t.address) === field);
    if (hit) return { symbol: hit.symbol, decimals: hit.decimals, resolved: true };
  } catch {
    /* storage blocked — fall through */
  }
  const cached = metaCache()[tokenAddressForField(field)];
  if (cached) return { ...cached, resolved: true };
  const hex = field.toString(16).padStart(40, "0");
  return { symbol: `0x${hex.slice(0, 4)}…${hex.slice(-4)}`, decimals: 18, resolved: false };
}
