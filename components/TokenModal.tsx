"use client";

import { useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import { TOKENS, type Token } from "@/lib/tokens";
import { fetchBalance, publicClient } from "@/lib/useWallet";

// Real token icon (self-hosted under /public/tokens), with a graceful fall back to
// the coloured initials glyph if the image is missing, failing, or the token is a
// custom import with no hosted icon.
function TokenGlyph({ symbol }: { symbol: string }) {
  const known = TOKENS.find((t) => t.symbol === symbol);
  const [errored, setErrored] = useState(false);

  if (known?.logoURI && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={known.logoURI}
        alt={symbol}
        width={32}
        height={32}
        onError={() => setErrored(true)}
        className="h-8 w-8 rounded-full shrink-0 object-cover bg-ink3"
      />
    );
  }

  const bg: Record<string, string> = {
    ETH: "#5b6bff",
    WETH: "#3b4a9e",
    USDG: "#d7fb08",
    COWL: "#0a0b0e",
  };
  const fg = symbol === "USDG" ? "#0a0b0e" : symbol === "COWL" ? "#d7fb08" : "#ececE7";
  return (
    <span
      className="h-8 w-8 rounded-full flex items-center justify-center text-[0.62rem] font-data shrink-0"
      style={{ background: bg[symbol] ?? "#14171c", color: fg, boxShadow: symbol === "COWL" ? "0 0 0 1px #d7fb08 inset" : "none" }}
    >
      {symbol.slice(0, 3)}
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
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [balances, setBalances] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open && allowImport) setImported(loadImported());
  }, [open, allowImport]);

  const base = tokens ?? TOKENS;
  const known = [
    ...base,
    ...imported.filter((i) => !base.some((b) => b.address.toLowerCase() === i.address.toLowerCase())),
  ];

  useEffect(() => {
    if (!open || !owner) {
      setBalances({});
      return;
    }
    let alive = true;
    Promise.all(known.map(async (t) => [t.symbol, await fetchBalance(owner, t)] as const)).then(
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
    const listed = [...base, ...imported].some((t) => t.address.toLowerCase() === addr.toLowerCase());
    if (listed) {
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
  }, [q, allowImport, open, imported]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const list = known
    .filter(
      (t) =>
        t.symbol !== exclude &&
        (t.symbol.toLowerCase().includes(needle) ||
          t.name.toLowerCase().includes(needle) ||
          t.address.toLowerCase() === needle),
    )
    .sort((a, b) => (parseFloat(balances[b.symbol] ?? "0") || 0) - (parseFloat(balances[a.symbol] ?? "0") || 0));

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
        <div className="max-h-[40vh] overflow-y-auto pb-2">
          {list.map((t) => {
            const bal = parseFloat(balances[t.symbol] ?? "0") || 0;
            return (
              <button
                key={`${t.symbol}-${t.address}`}
                onClick={() => {
                  onSelect(t);
                  onClose();
                }}
                className="w-full flex items-center gap-3 px-5 py-3 hover:bg-ink3 transition-colors text-left"
              >
                <TokenGlyph symbol={t.symbol} />
                <span className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm text-bone">{t.symbol}</span>
                  <span className="text-xs text-faint truncate">{t.name}</span>
                </span>
                {owner && (
                  <span className="font-data text-sm text-muted shrink-0">
                    {bal === 0 ? "0" : bal.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                  </span>
                )}
              </button>
            );
          })}

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
              <TokenGlyph symbol={lookup.token.symbol} />
              <span className="flex flex-col flex-1">
                <span className="text-sm text-bone">{lookup.token.symbol}</span>
                <span className="text-xs text-faint">{lookup.token.name}</span>
              </span>
              <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">Import</span>
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
