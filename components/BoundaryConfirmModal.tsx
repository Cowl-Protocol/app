"use client";

// Review-and-execute modal for the boundary. Before anything runs it shows the
// plan; Execute drives the real flow through the shielded context (prove in a
// worker, confirm in the wallet, wait for the receipt, part by part) and
// RunProgress renders that live. A spread fires its parts from this tab, so
// the copy asks for the tab to stay open until the last one lands.
import type { Token } from "@/lib/tokens";
import type { OpProgress } from "./ShieldedProvider";
import RunProgress from "./RunProgress";
import Spinner from "./Spinner";
import { TokenGlyph } from "./TokenModal";

export type BoundaryMode = "shield" | "unshield";

type Props = {
  open: boolean;
  mode: BoundaryMode;
  token: Token;
  amount: string;
  /** What the amount is worth, or null when the token has no price. */
  usd?: string | null;
  /** Boundary parts in base units — one transaction each. */
  parts: bigint[];
  /** Grouped denomination plan, e.g. "2 × 0.1 · 3 × 0.01" — omitted when exact. */
  planLabel?: string;
  remainderLabel?: string;
  exact: boolean;
  spread?: string;
  /** A relayer is standing by to carry this run, so no wallet confirmation comes. */
  gasless?: boolean;
  /** The relayer's total fee for the run, already formatted with its symbol. */
  relayFee?: string;
  /** What actually leaves the shielded book: the amount plus that fee. */
  relayDrawn?: string;
  /** Estimated native-coin gas when the wallet is the one paying. */
  networkFee?: string;
  /** The relayer's fee as a percent of the withdrawal, when it is a steep one. */
  steepFeePct?: number;
  /** Live run state from the shielded context, when a run is under way. */
  progress: OpProgress | null;
  onExecute: () => void;
  onClose: () => void;
};

const STEPS: Record<BoundaryMode, { k: string; d: string }[]> = {
  shield: [
    { k: "Denominate", d: "The amount goes out in shared sizes. Every 0.1 looks like every other 0.1" },
    { k: "Prove", d: "Each deposit is proven in the circuit, in your browser, one at a time" },
    { k: "Settle", d: "Your funds land under your shielded keys. Only you can spend them" },
  ],
  unshield: [
    { k: "Prove", d: "The proving happens here, in your browser. Nothing links these notes to their deposits" },
    { k: "Submit", d: "The spend goes out. All that surfaces is nullifiers and fresh outputs" },
    { k: "Arrive", d: "The value arrives at your address, in shared denominations" },
  ],
};

export default function BoundaryConfirmModal({
  open,
  mode,
  token,
  amount,
  usd,
  parts,
  planLabel,
  remainderLabel,
  exact,
  spread,
  gasless,
  relayFee,
  relayDrawn,
  networkFee,
  steepFeePct,
  progress,
  onExecute,
  onClose,
}: Props) {
  if (!open) return null;

  const running = !!progress && !progress.done && !progress.error;

  const title = mode === "shield" ? "Review shield" : "Review unshield";
  const fromLabel = mode === "shield" ? "Public wallet" : "Shielded balance";
  const toLabel = mode === "shield" ? "Shielded balance" : "Public wallet";
  const verb = mode === "shield" ? "Shield" : "Unshield";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/70"
      onClick={running ? undefined : onClose}
    >
      <div className="w-full max-w-md bg-card fade-up max-h-[84vh] scroll-acid" onClick={(e) => e.stopPropagation()}>
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
            {/* The dollar figure belongs on the last screen before signing, not
                only on the one where the number was typed. */}
            <span className="text-right whitespace-nowrap">
              <span className="font-data text-lg text-bone">
                {amount} {token.symbol}
              </span>
              {usd && <span className="block font-data text-[0.7rem] text-faint">{usd}</span>}
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
            <RunProgress progress={progress} />

            {running && progress.step === "record" && (
              <p className="flex items-center gap-2 text-[0.7rem] text-muted leading-relaxed pt-1">
                <Spinner className="h-3 w-3 text-acid" />
                Filing your notes. The funds have already moved.
              </p>
            )}
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
                  {/* Naming what it will do, because the parts above already
                      moved money and "try again" reads like it undoes them. */}
                  {progress.txs.length > 0
                    ? `Finish the remaining ${progress.parts.length - progress.txs.length}`
                    : "Try again"}
                </button>
              ) : (
                <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
                  <span className="flex items-center justify-center gap-2">
                    <Spinner className="h-3 w-3" />
                    {verb}ing
                  </span>
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
              <span className="text-faint font-data">Wallet confirmations</span>
              <span className={`font-data text-right ${gasless ? "text-acid" : "text-muted"}`}>
                {gasless
                  ? "None"
                  : parts.length === 1
                    ? "1"
                    : `${parts.length}${spread ? ", at random moments" : ", back to back"}`}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Gas payer</span>
              <span className={`font-data ${gasless ? "text-acid" : "text-muted"}`}>
                {gasless ? "The relayer" : mode === "shield" ? "You, per deposit" : "You, per withdrawal"}
              </span>
            </div>
            {!gasless && networkFee && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Network fee</span>
                <span className="font-data text-muted">{networkFee}</span>
              </div>
            )}
            {gasless && (
              <>
                {relayFee && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-faint font-data">Relayer fee</span>
                    <span className="font-data text-muted">{relayFee}</span>
                  </div>
                )}
                {relayDrawn && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-faint font-data">Leaves your notes</span>
                    <span className="font-data text-acid">{relayDrawn}</span>
                  </div>
                )}
                {steepFeePct !== undefined && (
                  <p className="text-[0.7rem] text-warn leading-relaxed">
                    That fee is {steepFeePct.toFixed(0)}% of what you are withdrawing. It costs one
                    spend&apos;s gas whatever the size, so a larger withdrawal pays the same fee and
                    a smaller share of it.
                  </p>
                )}
                <p className="text-[0.7rem] text-faint leading-relaxed">
                  The relayer submits and pays the gas, so the chain records it and not your
                  wallet. Its fee is bound into the proof before anything moves. It cannot charge a
                  wei more than the figure above.
                </p>
              </>
            )}

            {spread && (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                The parts fire at random moments across {spread}, so keep this tab open until the
                last one lands.
              </p>
            )}
            <button
              onClick={onExecute}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              {verb} now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
