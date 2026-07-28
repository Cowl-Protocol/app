"use client";

// Review-and-execute for a private trade. One atomic adapter call: the spend
// leaves the pool, the venue swaps it, and the exact output re-shields, all in
// the same transaction — revert anywhere and the trade never happened. The
// review says exactly that, then RunProgress renders the live run.
import type { OpProgress } from "./ShieldedProvider";
import RunProgress from "./RunProgress";
import Spinner from "./Spinner";
import { TokenGlyph } from "./TokenModal";

type Props = {
  open: boolean;
  paySymbol: string;
  payLogoURI?: string;
  receiveSymbol: string;
  receiveLogoURI?: string;
  /** The exact output, already formatted. */
  amountOut: string;
  /** The venue's current price for it, formatted in the pay token. */
  quotedIn: string;
  /** The input cap when it differs from the quote — self-paid headroom. */
  maxIn?: string;
  /** What the exact output is worth, or null when nothing prices it. */
  usd: string | null;
  /** A relayer is carrying this trade, so no wallet confirmation comes. */
  gasless?: boolean;
  /** Its fee, already formatted with the pay symbol. */
  relayFee?: string;
  /** What leaves the shielded book at most: the input cap plus that fee. */
  drawn?: string;
  /** Self-paid: the estimated gas the wallet is about to pay, formatted. */
  networkFee?: string;
  progress: OpProgress | null;
  onExecute: () => void;
  onClose: () => void;
};

const STEPS = (gasless: boolean) => [
  {
    k: "Prove",
    d: "Your browser spends your notes to the trade adapter, and proves the exact output's arrival before anything moves",
  },
  {
    k: "Swap",
    d: gasless
      ? "The relayer submits. The adapter draws from the pool, trades at the venue, and refunds what the router does not take"
      : "Your wallet submits. The adapter draws from the pool, trades at the venue, and refunds unused headroom to you",
  },
  {
    k: "Re-shield",
    d: "The exact output lands back in your shielded balance as a fresh note, in the same transaction",
  },
];

export default function SwapConfirmModal({
  open,
  paySymbol,
  payLogoURI,
  receiveSymbol,
  receiveLogoURI,
  amountOut,
  quotedIn,
  maxIn,
  usd,
  gasless = false,
  relayFee,
  drawn,
  networkFee,
  progress,
  onExecute,
  onClose,
}: Props) {
  if (!open) return null;

  const running = !!progress && !progress.done && !progress.error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/70"
      onClick={running ? undefined : onClose}
    >
      <div className="w-full max-w-md bg-card fade-up max-h-[84vh] scroll-acid" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">Review private swap</span>
          {!running && (
            <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        {/* What leaves, and what arrives */}
        <div className="px-5">
          <div className="bg-ink2 p-4 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={paySymbol} src={payLogoURI} />
              <span className="text-faint label-soft whitespace-nowrap">You pay</span>
            </span>
            <span className="text-right whitespace-nowrap">
              <span className="font-data text-lg text-bone">
                {quotedIn} {paySymbol}
              </span>
              {maxIn && (
                <span className="block font-data text-[0.7rem] text-faint">max {maxIn} {paySymbol}</span>
              )}
            </span>
          </div>
          <div className="bg-ink2 p-4 mt-1 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={receiveSymbol} src={receiveLogoURI} />
              <span className="text-faint label-soft whitespace-nowrap">You receive</span>
            </span>
            <span className="text-right whitespace-nowrap">
              <span className="font-data text-lg text-acid">
                {amountOut} {receiveSymbol}
              </span>
              <span className="block font-data text-[0.7rem] text-faint">{usd ?? "exact"}</span>
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
                Reading the chain back. The trade has already landed.
              </p>
            )}
            {running && (
              <p className="text-[0.7rem] text-faint leading-relaxed pt-1">
                Stay on this tab until the transaction lands.
              </p>
            )}
            {progress.error && (
              <p className="text-xs text-[#ff6b6b] leading-relaxed pt-1">{progress.error}</p>
            )}
            {progress.done && (
              <p className="text-xs text-muted leading-relaxed pt-1">
                Swapped. The output sits in your shielded balance as a fresh note.
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
                  <span className="flex items-center justify-center gap-2">
                    <Spinner className="h-3 w-3" />
                    Swapping
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ---- review ---- */
          <div className="px-5 py-5 space-y-4">
            {STEPS(gasless).map((s, i) => (
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

            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-faint font-data">On chain</span>
              <span className="font-data text-muted text-right">one atomic adapter call</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Output</span>
              <span className="font-data text-acid text-right">exact — proven in advance</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Wallet confirmations</span>
              <span className={`font-data text-right ${gasless ? "text-acid" : "text-muted"}`}>
                {gasless ? "0" : "1"}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Gas payer</span>
              <span className={`font-data text-right ${gasless ? "text-acid" : "text-muted"}`}>
                {gasless ? "The relayer" : "You"}
              </span>
            </div>
            {gasless && relayFee && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Relayer fee</span>
                <span className="font-data text-muted text-right">{relayFee}</span>
              </div>
            )}
            {drawn && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Drawn from your balance, at most</span>
                <span className="font-data text-acid text-right">{drawn}</span>
              </div>
            )}
            {!gasless && networkFee && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Network fee</span>
                <span className="font-data text-muted text-right">{networkFee}</span>
              </div>
            )}

            <p className="text-[0.7rem] text-faint leading-relaxed">
              The swap itself is public — the venue prints its size and price like any other. Who
              made it is not: the notes that funded it stay sealed
              {gasless
                ? ", and the relayer submits, so no wallet of yours appears anywhere in it."
                : ". Self-paid, your wallet submits the trade and shows as its caller."}
            </p>
            <p className="text-[0.7rem] text-faint leading-relaxed">
              The price is the venue&apos;s at execution, re-quoted just before proving. If it moves
              past the input cap while the proof is being made, the trade fails closed — nothing is
              drawn, nothing is broadcast.
            </p>
            <button
              onClick={onExecute}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              Swap now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
