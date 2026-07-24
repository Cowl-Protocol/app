"use client";

import { useState } from "react";
import { TOKENS, tokenBySymbol, type Token } from "@/lib/tokens";

// Real token icon (self-hosted under /public/tokens), with a graceful fall back to
// the coloured initials glyph if the image is missing or fails to load.
function TokenGlyph({ symbol }: { symbol: string }) {
  const token = tokenBySymbol(symbol);
  const [errored, setErrored] = useState(false);

  if (token.logoURI && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={token.logoURI}
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
      className="h-8 w-8 rounded-full flex items-center justify-center text-[0.62rem] font-mono shrink-0"
      style={{ background: bg[symbol] ?? "#14171c", color: fg, boxShadow: symbol === "COWL" ? "0 0 0 1px #d7fb08 inset" : "none" }}
    >
      {symbol.slice(0, 3)}
    </span>
  );
}

export { TokenGlyph };

type Props = {
  open: boolean;
  exclude?: string;
  onClose: () => void;
  onSelect: (t: Token) => void;
};

export default function TokenModal({ open, exclude, onClose, onSelect }: Props) {
  const [q, setQ] = useState("");
  if (!open) return null;

  const list = TOKENS.filter(
    (t) =>
      t.symbol !== exclude &&
      (t.symbol.toLowerCase().includes(q.toLowerCase()) ||
        t.name.toLowerCase().includes(q.toLowerCase())),
  );

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
            placeholder="Search name or symbol"
            className="w-full bg-ink px-4 py-3 text-sm text-bone placeholder:text-faint font-mono"
          />
        </div>
        <div className="max-h-[40vh] overflow-y-auto pb-2">
          {list.map((t) => (
            <button
              key={t.symbol}
              onClick={() => {
                onSelect(t);
                onClose();
              }}
              className="w-full flex items-center gap-3 px-5 py-3 hover:bg-ink3 transition-colors text-left"
            >
              <TokenGlyph symbol={t.symbol} />
              <span className="flex flex-col">
                <span className="text-sm text-bone">{t.symbol}</span>
                <span className="text-xs text-faint">{t.name}</span>
              </span>
            </button>
          ))}
          {list.length === 0 && (
            <p className="px-5 py-6 text-center text-sm text-faint">No tokens found</p>
          )}
        </div>
      </div>
    </div>
  );
}
