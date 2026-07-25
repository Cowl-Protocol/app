"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { iconIsDead, iconsServerVersion, iconsVersion, markIconDead, subscribeIcons } from "@/lib/iconStore";
import { getAddress, isAddress } from "viem";
import { TOKENS, type Token } from "@/lib/tokens";
import { fetchTokenList } from "@/lib/tokenList";
import { useAssets, type Asset } from "@/lib/assets";
import AssetRow from "./AssetRow";
import { publicClient } from "@/lib/useWallet";

// Real token icon (self-hosted under /public/tokens), with a graceful fall back to
// the coloured initials glyph if the image is missing, failing, or the token is a
// custom import with no hosted icon.
const GLYPH_BG: Record<string, string> = {
  ETH: "#5b6bff",
  WETH: "#3b4a9e",
  USDG: "#d7fb08",
  COWL: "#0a0b0e",
};

/**
 * Token mark: the symbol set in type, with the hosted icon over it.
 *
 * The icon renders by default and is removed only when it fails, which is the
 * opposite of the obvious design and the only one that holds. Waiting for an
 * onLoad before revealing the image loses every icon whose load finished
 * before React attached the handler, and an image served from cache almost
 * always does — the icons were arriving intact and staying invisible.
 *
 * A host that has already refused is not asked again, so the broken picture
 * the browser draws while an error is in flight happens once rather than on
 * every row of every visit. See lib/iconStore.
 */
function TokenGlyph({ symbol, src }: { symbol: string; src?: string }) {
  const known = TOKENS.find((t) => t.symbol === symbol);
  const logo = src ?? known?.logoURI;

  // Re-renders this glyph when any other one retires the host it was about to use.
  useSyncExternalStore(subscribeIcons, iconsVersion, iconsServerVersion);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [logo]);

  const showIcon = !!logo && !failed && !iconIsDead(logo);

  const initials = symbol.length <= 4 ? symbol : symbol.slice(0, 3);
  const size = initials.length >= 4 ? "text-[0.5rem]" : "text-[0.62rem]";
  const fg = symbol === "USDG" ? "#0a0b0e" : symbol === "COWL" ? "#d7fb08" : "#ececE7";

  // inline-flex, not a bare span: width and height do not apply to an inline
  // element, so the wrapper collapsed to nothing and both layers landed on top
  // of each other, spilling outside the circle.
  return (
    <span className="relative inline-flex h-8 w-8 shrink-0 overflow-hidden rounded-full">
      <span
        className={`absolute inset-0 flex items-center justify-center font-data tracking-tight ${size}`}
        style={{
          background: GLYPH_BG[symbol] ?? "#1c2027",
          color: fg,
          boxShadow: symbol === "COWL" ? "0 0 0 1px #d7fb08 inset" : "none",
        }}
      >
        {initials}
      </span>
      {showIcon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          width={32}
          height={32}
          onError={() => {
            markIconDead(logo);
            setFailed(true);
          }}
          className="absolute inset-0 h-8 w-8 object-cover"
        />
      )}
    </span>
  );
}

export { TokenGlyph };

// Custom imports (tokenized stocks and other RWAs live as plain ERC-20s on
// Robinhood Chain) persist locally so a pasted address only has to be pasted once.
const IMPORT_KEY = "cowl.importedTokens";

function loadImported(): Token[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(IMPORT_KEY);
    return raw ? (JSON.parse(raw) as Token[]) : [];
  } catch {
    return [];
  }
}

function saveImported(list: Token[]) {
  try {
    localStorage.setItem(IMPORT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked — the import still works for this session */
  }
}

const ERC20_META_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "found"; token: Token }
  | { state: "error" };

type Props = {
  open: boolean;
  exclude?: string;
  /** Curated list override — defaults to the swap list. */
  tokens?: Token[];
  /** Let a pasted ERC-20 address import a custom asset (RWA stocks and the rest). */
  allowImport?: boolean;
  /** Connected wallet — rows show its balance, largest holdings first. */
  owner?: `0x${string}` | null;
  onClose: () => void;
  onSelect: (t: Token) => void;
};

export default function TokenModal({ open, exclude, tokens, allowImport, owner, onClose, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [imported, setImported] = useState<Token[]>([]);
  const [listed, setListed] = useState<Token[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });

  // The wallet's own assets, balances and prices included, from the same source
  // the portfolio reads. A token discovered a moment ago arrives with its
  // balance attached rather than needing a second pass to fill it in.
  const { assets, loading: assetsLoading } = useAssets(open ? (owner ?? null) : null);

  useEffect(() => {
    if (open && allowImport) setImported(loadImported());
  }, [open, allowImport]);

  // The live chain list, explorer-sourced, joins the curated set when importing
  // is on. Curated and imported entries win duplicates by address.
  useEffect(() => {
    if (!open || !allowImport) return;
    let alive = true;
    setListLoading(true);
    fetchTokenList().then((l) => {
      if (!alive) return;
      setListed(l);
      setListLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open, allowImport]);

  // Pinned = the wallet's assets, the curated boundary set, and anything
  // imported by hand. The live chain list follows underneath.
  const base = tokens ?? TOKENS;
  const byAddress = new Map<string, Asset>();
  for (const a of assets) byAddress.set(a.token.address.toLowerCase(), a);
  const asAsset = (t: Token): Asset =>
    byAddress.get(t.address.toLowerCase()) ?? { token: t, balance: null, price: null, status: "unasked" };

  const seen = new Set<string>();
  const pinned: Asset[] = [...base.map(asAsset), ...assets, ...imported.map(asAsset)].filter((a) => {
    const key = a.token.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const known = [
    ...pinned,
    ...listed
      .filter((l) => !seen.has(l.address.toLowerCase()))
      .map((l) => ({ token: l, balance: null, price: null, status: "unasked" }) as Asset),
  ];

  // A pasted address that isn't already listed gets read straight off the chain.
  useEffect(() => {
    const addr = q.trim();
    if (!allowImport || !open || !isAddress(addr)) {
      setLookup({ state: "idle" });
      return;
    }
    const alreadyListed = known.some((a) => a.token.address.toLowerCase() === addr.toLowerCase());
    if (alreadyListed) {
      setLookup({ state: "idle" });
      return;
    }
    let alive = true;
    setLookup({ state: "loading" });
    (async () => {
      try {
        const address = getAddress(addr);
        const [symbol, name, decimals] = await Promise.all([
          publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
          publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "name" }),
          publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
        ]);
        if (!alive) return;
        setLookup({ state: "found", token: { symbol, name, address, decimals: Number(decimals) } });
      } catch {
        if (alive) setLookup({ state: "error" });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, allowImport, open, imported, listed]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const matches = ({ token: t }: Asset) =>
    t.symbol !== exclude &&
    (t.symbol.toLowerCase().includes(needle) ||
      t.name.toLowerCase().includes(needle) ||
      t.address.toLowerCase() === needle);

  // What you hold rises to the top; the rest of the curated set follows.
  const pinnedRows = pinned.filter(matches).sort((a, b) => {
    const av = a.balance ?? 0n;
    const bv = b.balance ?? 0n;
    return bv === av ? 0 : bv > av ? 1 : -1;
  });
  const listedRows = known.filter((a) => !pinned.includes(a)).filter(matches);
  const list = [...pinnedRows, ...listedRows];

  const choose = (a: Asset) => {
    onSelect(a.token);
    onClose();
  };

  const importToken = (t: Token) => {
    const next = [...imported, t];
    setImported(next);
    saveImported(next);
    onSelect(t);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-card fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">Select a token</span>
          <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
            ✕
          </button>
        </div>
        <div className="px-5 pb-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={allowImport ? "Search, or paste a token address" : "Search name or symbol"}
            className="w-full bg-ink px-4 py-3 text-sm text-bone placeholder:text-faint font-data"
          />
        </div>
        <div className="max-h-[52vh] overflow-y-auto pb-2">
          {pinnedRows.length > 0 && (
            <>
              {allowImport && (
                <p className="label-soft text-faint px-5 pt-1 pb-2 sticky top-0 bg-card z-10">Boundary assets</p>
              )}
              {pinnedRows.map((a) => (
                <AssetRow
                  key={a.token.address}
                  asset={a}
                  onPick={choose}
                  showAddress
                  loading={!!owner && assetsLoading}
                />
              ))}
            </>
          )}

          {listedRows.length > 0 && (
            <>
              <p className="label-soft text-faint px-5 pt-3 pb-2 sticky top-0 bg-card z-10">Tokens by holders</p>
              {listedRows.map((a) => (
                <AssetRow
                  key={a.token.address}
                  asset={a}
                  onPick={choose}
                  showAddress
                  trailing={
                    a.token.holders
                      ? `${Intl.NumberFormat("en-US", { notation: "compact" }).format(a.token.holders)} holders`
                      : undefined
                  }
                />
              ))}
            </>
          )}

          {listLoading && allowImport && (
            <p className="px-5 py-3 text-xs text-faint">Loading the token list…</p>
          )}

          {lookup.state === "loading" && (
            <p className="px-5 py-4 text-xs text-faint">Reading token…</p>
          )}
          {lookup.state === "error" && (
            <p className="px-5 py-4 text-xs text-faint">Couldn&apos;t read a token at that address.</p>
          )}
          {lookup.state === "found" && (
            <button
              onClick={() => importToken(lookup.token)}
              className="w-full flex items-center gap-3 px-5 py-3 hover:bg-ink3 transition-colors text-left"
            >
              <TokenGlyph symbol={lookup.token.symbol} src={lookup.token.logoURI} />
              <span className="flex flex-col flex-1 min-w-0">
                <span className="text-sm text-bone truncate">{lookup.token.name}</span>
                <span className="text-xs text-faint truncate">{lookup.token.symbol}</span>
              </span>
              <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10] shrink-0">Import</span>
            </button>
          )}

          {list.length === 0 && lookup.state === "idle" && (
            <p className="px-5 py-6 text-center text-sm text-faint">
              {allowImport ? "No match. Paste a contract address to import it" : "No tokens found"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
