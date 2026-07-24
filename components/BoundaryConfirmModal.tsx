"use client";

import { useState } from "react";
import type { Token } from "@/lib/tokens";
import { TokenGlyph } from "./TokenModal";

export type BoundaryMode = "shield" | "unshield";

type Props = {
  open: boolean;
  mode: BoundaryMode;
  token: Token;
  amount: string;
  /** Grouped denomination plan, e.g. "2 × 0.1 · 3 × 0.01" — omitted when exact. */
  planLabel?: string;
  /** Number of boundary transactions the plan fans out into. */
  txCount: number;
  /** Sub-tier remainder note, if any. */
  remainderLabel?: string;
  exact: boolean;
  spread?: string;
  relay?: string;
  onClose: () => void;
};

const STEPS: Record<BoundaryMode, { k: string; d: string }[]> = {
  shield: [
    { k: "Denominate", d: "The amount travels in shared tiers — every 0.1 looks like every other 0.1" },
    { k: "Prove", d: "Each deposit proves its own leaf insertion in-circuit before it settles" },
    { k: "Settle", d: "Notes land in the pool under your shielded keys — only you can spend them" },
  ],
  unshield: [
    { k: "Prove", d: "Spend your notes in-circuit — nothing links them back to their deposits" },
    { k: "Relay", d: "The relayer submits and pays gas; your wallet never signs" },
    { k: "Arrive", d: "Funds land in your wallet in shared denominations" },
  ],
};

export default function BoundaryConfirmModal({
  open,
  mode,
  token,
  amount,
  planLabel,
  txCount,
  remainderLabel,
  exact,
  spread,
  relay,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  // The CLI takes the native symbol by default and an ERC-20 address otherwise —
  // its symbol table maps to the local sim, so the on-chain USDG goes by address.
  const tokenArg = token.native ? "" : ` ${token.address}`;
  const cliCmd = `cowl ${mode} ${amount}${tokenArg}${exact ? " --exact" : ""}${spread ? ` --spread ${spread}` : ""}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cliCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the command is visible to copy manually */
    }
  };

  const title = mode === "shield" ? "Review shield" : "Review unshield";
  const fromLabel = mode === "shield" ? "From public wallet" : "From shielded balance";
  const toLabel = mode === "shield" ? "To shielded balance" : "To public wallet";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md bg-card fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">{title}</span>
          <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
            ✕
          </button>
        </div>

        {/* Amounts */}
        <div className="px-5">
          <div className="bg-ink2 p-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={token.symbol} />
              <span className="text-faint text-xs label-mono">{fromLabel}</span>
            </span>
            <span className="font-data text-lg text-bone">
              {amount} {token.symbol}
            </span>
          </div>
          <div className="h-px" />
          <div className="bg-ink2 p-4 flex items-center justify-between mt-1">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={token.symbol} />
              <span className="text-faint text-xs label-mono">{toLabel}</span>
            </span>
            <span className="font-data text-lg text-acid">
              {mode === "unshield" && relay ? "≈ " : ""}
              {amount} {token.symbol}
            </span>
          </div>
        </div>

        {/* Plan */}
        <div className="px-5 py-5 space-y-4">
          {STEPS[mode].map((s, i) => (
            <div key={s.k} className="flex gap-3">
              <span className="shrink-0 h-6 w-6 flex items-center justify-center bg-ink3 text-acid label-mono text-[0.62rem]">
                {i + 1}
              </span>
              <div>
                <p className="label-mono text-[0.68rem] text-bone">{s.k}</p>
                <p className="text-xs text-muted mt-0.5">{s.d}</p>
              </div>
            </div>
          ))}

          {planLabel && (
            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-faint font-mono">Plan</span>
              <span className="font-mono text-muted">
                {planLabel} · {txCount} {mode === "shield" ? (txCount === 1 ? "deposit" : "deposits") : txCount === 1 ? "withdrawal" : "withdrawals"}
              </span>
            </div>
          )}
          {exact && (
            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-faint font-mono">Boundary</span>
              <span className="font-mono text-muted">exact amount · 1 transaction</span>
            </div>
          )}
          {remainderLabel && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-mono">Remainder</span>
              <span className="font-mono text-muted">{remainderLabel}</span>
            </div>
          )}
          {spread && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-mono">Spread</span>
              <span className="font-mono text-muted">{spread} window · random moments</span>
            </div>
          )}
          {mode === "unshield" && relay && (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-mono">Relayer</span>
                <span className="font-mono text-acid">{relay.replace("https://", "")}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-mono">Relayer fee</span>
                <span className="font-mono text-muted">paid from shielded funds</span>
              </div>
            </>
          )}
        </div>

        {/* Browser proving not yet wired — hand off to the CLI, honestly */}
        <div className="px-5 pb-5">
          <div className="bg-ink2 p-4">
            <p className="text-xs text-muted leading-relaxed">
              In-browser proving is on the way. Right now the shielded proof runs locally — run this
              from the terminal:
            </p>
            <div className="mt-3 flex items-center justify-between bg-ink px-3 py-2.5">
              <code className="font-data text-[0.8rem] text-acid break-all">{cliCmd}</code>
              <button onClick={copy} className="label-mono text-[0.6rem] text-muted hover:text-bone shrink-0 ml-3">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <a
              href="https://cowlprotocol.com/docs"
              className="block mt-3 label-mono text-[0.6rem] text-faint hover:text-bone"
            >
              Install the CLI → cowlprotocol.com/docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
