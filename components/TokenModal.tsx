"use client";

import { useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import { TOKENS, type Token } from "@/lib/tokens";
import { fetchTokenList } from "@/lib/tokenList";
import { fetchBalance, publicClient } from "@/lib/useWallet";

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
 * Token mark: the symbol set in type, with the hosted icon layered over it once
 * it actually loads. Written this way on purpose — several issuers host their
 * logos on CDNs that hang rather than fail for some visitors, and an icon that
 * never resolves would otherwise leave an empty disc with no onError to catch.
 */
function TokenGlyph({ symbol, src }: { symbol: string; src?: string }) {
  const known = TOKENS.find((t) => t.symbol === symbol);
  const [loaded, setLoaded] = useState(false);
  const logo = src ?? known?.logoURI;

  const initials = symbol.length <= 4 ? symbol : symbol.slice(0, 3);
  const size = initials.length >= 4 ? "text-[0.5rem]" : "text-[0.62rem]";
  const fg = symbol === "USDG" ? "#0a0b0e" : symbol === "COWL" ? "#d7fb08" : "#ececE7";

  return (
    <span className="relative h-8 w-8 shrink-0">
      <span
        className={`absolute inset-0 rounded-full flex items-center justify-center font-data tracking-tight ${size}`}
        style={{
          background: GLYPH_BG[symbol] ?? "#1c2027",
          color: fg,
          boxShadow: symbol === "COWL" ? "0 0 0 1px #d7fb08 inset" : "none",
        }}
      >
        {initials}
      </span>
      {logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={symbol}
          width={32}
          height={32}
          onLoad={() => setLoaded(true)}
          className={`absolute inset-0 h-8 w-8 rounded-full object-cover transition-opacity duration-200 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
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
  const [balances, setBalances] = useState<Record<string, string>>({});

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

  const base = tokens ?? TOKENS;
  const pinned = [
    ...base,
    ...imported.filter((i) => !base.some((b) => b.address.toLowerCase() === i.address.toLowerCase())),
  ];
  const known = [
    ...pinned,
    ...listed.filter((l) => !pinned.some((p) => p.address.toLowerCase() === l.address.toLowerCase())),
  ];

  // Balances load for the pinned set only; the live list would be hundreds of
  // calls, and its rows carry holder counts instead.
  useEffect(() => {
    if (!open || !owner) {
      setBalances({});
      return;
    }
    let alive = true;
    Promise.all(pinned.map(async (t) => [t.address, await fetchBalance(owner, t)] as const)).then(
      (rows) => {
        if (alive) setBalances(Object.fromEntries(rows));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, owner, imported]);

  // A pasted address that isn't already listed gets read straight off the chain.
  useEffect(() => {
    const addr = q.trim();
    if (!allowImport || !open || !isAddress(addr)) {
      setLookup({ state: "idle" });
      return;
    }
    const alreadyListed = known.some((t) => t.address.toLowerCase() === addr.toLowerCase());
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
  const matches = (t: Token) =>
    t.symbol !== exclude &&
    (t.symbol.toLowerCase().includes(needle) ||
      t.name.toLowerCase().includes(needle) ||
      t.address.toLowerCase() === needle);

  const pinnedRows = pinned
    .filter(matches)
    .sort(
      (a, b) =>
        (parseFloat(balances[b.address] ?? "0") || 0) - (parseFloat(balances[a.address] ?? "0") || 0),
    );
  const listedRows = known.filter((t) => !pinned.includes(t)).filter(matches);
  const list = [...pinnedRows, ...listedRows];

  const choose = (t: Token) => {
    onSelect(t);
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
              {pinnedRows.map((t) => (
                <Row key={`${t.symbol}-${t.address}`} token={t} balance={balances[t.address]} onPick={choose} />
              ))}
            </>
          )}

          {listedRows.length > 0 && (
            <>
              <p className="label-soft text-faint px-5 pt-3 pb-2 sticky top-0 bg-card z-10">Tokens by holders</p>
              {listedRows.map((t) => (
                <Row key={`${t.symbol}-${t.address}`} token={t} onPick={choose} />
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

// Robinhood's tokenized assets all carry the same suffix on chain. The row shows
// the asset itself and marks the class, so the name isn't spent on boilerplate.
const TOKENIZED_MARK = " \u2022 Robinhood Token";

function isTokenized(name: string): boolean {
  return name.endsWith(TOKENIZED_MARK);
}

function displayName(name: string): string {
  return isTokenized(name) ? name.slice(0, -TOKENIZED_MARK.length) : name;
}

function Row({
  token,
  balance,
  onPick,
}: {
  token: Token;
  balance?: string;
  onPick: (t: Token) => void;
}) {
  const bal = parseFloat(balance ?? "0") || 0;
  return (
    <button
      onClick={() => onPick(token)}
      className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-ink3 transition-colors text-left"
    >
      <TokenGlyph symbol={token.symbol} src={token.logoURI} />
      <span className="flex flex-col flex-1 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-bone truncate">{displayName(token.name)}</span>
          {isTokenized(token.name) && (
            <span className="label-soft text-[0.55rem] text-acid bg-[#161a10] px-1.5 py-0.5 shrink-0">RWA</span>
          )}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-faint">{token.symbol}</span>
          {!token.native && (
            <span className="font-data text-[0.65rem] text-faint/70 truncate">
              {token.address.slice(0, 6)}…{token.address.slice(-4)}
            </span>
          )}
        </span>
      </span>
      {balance !== undefined ? (
        <span className="font-data text-sm text-muted shrink-0">
          {bal === 0 ? "0" : bal.toLocaleString("en-US", { maximumFractionDigits: 4 })}
        </span>
      ) : token.holders ? (
        <span className="font-data text-[0.68rem] text-faint shrink-0">
          {Intl.NumberFormat("en-US", { notation: "compact" }).format(token.holders)} holders
        </span>
      ) : null}
    </button>
  );
}
