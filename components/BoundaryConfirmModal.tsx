"use client";

// Review-and-execute modal for the boundary. Before anything runs it shows the
// plan; Execute drives the real flow through the shielded context (prove in a
// worker, confirm in the wallet, wait for the receipt, part by part) and this
// modal renders that progress live. A timed spread has to keep firing after
// the tab sleeps, so that one stays a CLI job and the modal says so.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "@/lib/networks";
import { formatRemaining } from "@/lib/spread";
import type { Token } from "@/lib/tokens";
import type { OpProgress, OpStep } from "./ShieldedProvider";
import { TokenGlyph } from "./TokenModal";

export type BoundaryMode = "shield" | "unshield";

type Props = {
  open: boolean;
  mode: BoundaryMode;
  token: Token;
  amount: string;
  /** Boundary parts in base units — one transaction each. */
  parts: bigint[];
  /** Grouped denomination plan, e.g. "2 × 0.1 · 3 × 0.01" — omitted when exact. */
  planLabel?: string;
  remainderLabel?: string;
  exact: boolean;
  spread?: string;
  /** Live run state from the shielded context, when a run is under way. */
  progress: OpProgress | null;
  onExecute: () => void;
  onClose: () => void;
};

const STEPS: Record<BoundaryMode, { k: string; d: string }[]> = {
  shield: [
    { k: "Denominate", d: "The amount travels in shared tiers where every 0.1 looks like every other 0.1" },
    { k: "Prove", d: "Your browser proves each deposit's leaf insertion inside the circuit" },
    { k: "Settle", d: "Notes land in the pool under your shielded keys. Only you can spend them" },
  ],
  unshield: [
    { k: "Prove", d: "Your browser spends the notes inside the circuit. Nothing links them to their deposits" },
    { k: "Submit", d: "Your wallet sends the spend; only nullifiers and fresh outputs go public" },
    { k: "Arrive", d: "Value lands at your address in shared denominations" },
  ],
};

const STEP_LABEL: Record<OpStep, string> = {
  unlock: "sign to unlock in your wallet",
  wait: "waiting",
  sync: "syncing the pool",
  prove: "proving in your browser",
  confirm: "confirm in your wallet",
  mined: "landed",
};

export default function BoundaryConfirmModal({
  open,
  mode,
  token,
  amount,
  parts,
  planLabel,
  remainderLabel,
  exact,
  spread,
  progress,
  onExecute,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);

  // A visible countdown needs a local heartbeat; the value it renders still
  // comes from the end time the run published, never from counting frames.
  const waitUntil = progress?.waitUntil;
  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [waitUntil]);

  if (!open) return null;

  const net = activeNetwork();
  const tokenArg = token.native ? "" : ` ${token.address}`;
  const cliCmd = `cowl ${mode} ${amount}${tokenArg} -n ${net.key}${exact ? " --exact" : ""}${spread ? ` --spread ${spread}` : ""}`;
  const running = !!progress && !progress.done && !progress.error;

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
  const fromLabel = mode === "shield" ? "Public wallet" : "Shielded balance";
  const toLabel = mode === "shield" ? "Shielded balance" : "Public wallet";
  const verb = mode === "shield" ? "Shield" : "Unshield";

  const fmtPart = (v: bigint) => {
    const s = formatUnits(v, token.decimals);
    return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/70"
      onClick={running ? undefined : onClose}
    >
      <div className="w-full max-w-md bg-card fade-up max-h-[84vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">{title}</span>
          {!running && (
            <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        {/* Amounts */}
        <div className="px-5">
          <div className="bg-ink2 p-4 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={token.symbol} src={token.logoURI} />
              <span className="text-faint label-soft whitespace-nowrap">{fromLabel}</span>
            </span>
            <span className="font-data text-lg text-bone whitespace-nowrap">
              {amount} {token.symbol}
            </span>
          </div>
          <div className="h-px" />
          <div className="bg-ink2 p-4 flex items-center justify-between mt-1 gap-3">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={token.symbol} src={token.logoURI} />
              <span className="text-faint label-soft whitespace-nowrap">{toLabel}</span>
            </span>
            <span className="font-data text-lg text-acid whitespace-nowrap">
              {amount} {token.symbol}
            </span>
          </div>
        </div>

        {progress ? (
          /* ---- live run ---- */
          <div className="px-5 py-5 space-y-2">
            {progress.parts.map((p, i) => {
              const tx = progress.txs.find((t) => t.part === i);
              const isCurrent = i === progress.current && !progress.done && !progress.error;
              const isDone = !!tx;
              const failedHere = !!progress.error && i === progress.current;
              return (
                <div key={i} className="bg-ink2 px-4 py-3 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-3 min-w-0">
                    <span
                      className={`shrink-0 h-6 w-6 flex items-center justify-center label-mono text-[0.62rem] ${
                        isDone ? "bg-acid text-ink" : failedHere ? "bg-[#3a1414] text-[#ff6b6b]" : "bg-ink3 text-acid"
                      }`}
                    >
                      {isDone ? "✓" : i + 1}
                    </span>
                    <span className="font-data text-sm text-bone whitespace-nowrap">
                      {fmtPart(p)} {progress.symbol}
                    </span>
                  </span>
                  <span className="text-right min-w-0">
                    {isDone && tx ? (
                      <a
                        href={`${net.explorer}/tx/${tx.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-data text-xs text-acid hover:text-acid2"
                      >
                        {tx.hash.slice(0, 10)}… ↗
                      </a>
                    ) : failedHere ? (
                      <span className="font-data text-xs text-[#ff6b6b]">failed</span>
                    ) : isCurrent ? (
                      <span className="font-data text-xs text-muted">
                        <span className="inline-block h-2.5 w-2.5 mr-2 align-middle border-2 border-acid border-t-transparent rounded-full spin" />
                        {progress.step === "wait" && progress.waitUntil
                          ? `firing in ${formatRemaining(progress.waitUntil - Date.now())}`
                          : STEP_LABEL[progress.step]}
                      </span>
                    ) : (
                      <span className="font-data text-xs text-faint">waiting</span>
                    )}
                  </span>
                </div>
              );
            })}

            {running && (
              <p className="text-[0.7rem] text-faint leading-relaxed pt-1">
                Keep this tab open until the last part lands.
                {spread ? " The remaining parts are still waiting on the clock." : ""} A deposit
                that has already gone out is safe either way.
              </p>
            )}
            {progress.error && (
              <p className="text-xs text-[#ff6b6b] leading-relaxed pt-1">{progress.error}</p>
            )}
            {progress.done && (
              <p className="text-xs text-muted leading-relaxed pt-1">
                Done. {progress.txs.length === 1 ? "1 transaction" : `${progress.txs.length} transactions`} landed;
                your balances are updated.
              </p>
            )}

            <div className="pt-3">
              {progress.done ? (
                <button
                  onClick={onClose}
                  className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
                >
                  Close
                </button>
              ) : progress.error ? (
                <button
                  onClick={onExecute}
                  className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
                >
                  Try again
                </button>
              ) : (
                <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
                  {verb}ing…
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ---- review ---- */
          <div className="px-5 py-5 space-y-4">
            {STEPS[mode].map((s, i) => (
              <div key={s.k} className="flex gap-3">
                <span className="shrink-0 h-6 w-6 flex items-center justify-center bg-ink3 text-acid label-mono text-[0.62rem]">
                  {i + 1}
                </span>
                <div>
                  <p className="label-soft text-bone">{s.k}</p>
                  <p className="text-xs text-muted mt-0.5">{s.d}</p>
                </div>
              </div>
            ))}

            {planLabel && (
              <div className="flex items-center justify-between text-xs pt-1 gap-4">
                <span className="text-faint font-data shrink-0">Plan</span>
                <span className="font-data text-muted text-right">
                  {planLabel} · {parts.length}{" "}
                  {mode === "shield"
                    ? parts.length === 1 ? "deposit" : "deposits"
                    : parts.length === 1 ? "withdrawal" : "withdrawals"}
                </span>
              </div>
            )}
            {exact && (
              <div className="flex items-center justify-between text-xs pt-1">
                <span className="text-faint font-data">Boundary</span>
                <span className="font-data text-muted">exact amount · 1 transaction</span>
              </div>
            )}
            {remainderLabel && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Remainder</span>
                <span className="font-data text-muted text-right">{remainderLabel}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Gas payer</span>
              <span className="font-data text-muted">
                {mode === "shield" ? "You, per deposit" : "You, per withdrawal"}
              </span>
            </div>

            {spread && (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                The parts fire at random moments across {spread}, so keep this tab open until the
                last one lands. The terminal can carry a long window instead.
              </p>
            )}
            <button
              onClick={onExecute}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              {verb} now
            </button>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.7rem] text-faint shrink-0">Prefer the terminal?</span>
              <span className="flex items-center gap-2 min-w-0">
                <code className="font-data text-[0.7rem] text-muted truncate">{cliCmd}</code>
                <button onClick={copy} className="label-soft text-faint hover:text-bone shrink-0">
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
