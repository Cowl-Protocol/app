"use client";

import { activeNetwork } from "./networks";
import type { Token } from "./tokens";

// Live ERC-20 list for the active network, read off its Blockscout explorer the
// way a wallet reads a token list. On mainnet this is where Robinhood's RWAs
// live (Tesla, NVIDIA, the S&P, all issued as plain ERC-20s), so the selector
// shows the real chain instead of a hand-picked handful. Nothing is hardcoded:
// symbol, name, decimals, icon, holder count and USD price all come from the
// explorer, and the list is cached for half an hour per network.

const TTL = 30 * 60 * 1000;
const PAGES = 2; // 50 per page, top of the list by market cap

type ApiItem = {
  address_hash?: string;
  address?: string;
  decimals: string | null;
  holders_count?: string;
  holders?: string;
  icon_url: string | null;
  name: string | null;
  symbol: string | null;
  reputation?: string | null;
  exchange_rate?: string | null;
  type: string;
};

type Cached = { at: number; items: Token[] };

let memo: Cached | null = null;
let memoKey = "";

function readCache(key: string): Cached | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    return Date.now() - parsed.at < TTL ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchTokenList(): Promise<Token[]> {
  const net = activeNetwork();
  const cacheKey = `cowl.tokenlist.${net.key}`;

  if (memo && memoKey === cacheKey && Date.now() - memo.at < TTL) return memo.items;
  const cached = readCache(cacheKey);
  if (cached) {
    memo = cached;
    memoKey = cacheKey;
    return cached.items;
  }

  try {
    const items: ApiItem[] = [];
    let url = `${net.explorer}/api/v2/tokens?type=ERC-20`;
    for (let page = 0; page < PAGES && url; page++) {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = (await res.json()) as { items?: ApiItem[]; next_page_params?: Record<string, unknown> };
      items.push(...(data.items ?? []));
      const np = data.next_page_params;
      url = np
        ? `${net.explorer}/api/v2/tokens?type=ERC-20&` +
          new URLSearchParams(Object.entries(np).map(([k, v]) => [k, String(v)])).toString()
        : "";
    }

    const tokens: Token[] = items
      .filter(
        (it) =>
          it.type === "ERC-20" &&
          it.symbol &&
          it.name &&
          it.decimals != null &&
          (it.address_hash ?? it.address) &&
          it.reputation !== "scam" &&
          it.reputation !== "suspicious",
      )
      .map((it) => ({
        symbol: it.symbol as string,
        name: it.name as string,
        address: (it.address_hash ?? it.address) as `0x${string}`,
        decimals: Number(it.decimals),
        logoURI: it.icon_url ?? undefined,
        holders: Number(it.holders_count ?? it.holders) || 0,
        priceUsd: it.exchange_rate ? Number(it.exchange_rate) || undefined : undefined,
      }))
      .sort((a, b) => (b.holders ?? 0) - (a.holders ?? 0));

    memo = { at: Date.now(), items: tokens };
    memoKey = cacheKey;
    try {
      window.localStorage.setItem(cacheKey, JSON.stringify(memo));
    } catch {
      /* storage blocked, the in-memory copy still serves this session */
    }
    return tokens;
  } catch {
    return [];
  }
}
