"use client";

// Review-and-execute for a private send. One transaction, no public leg: the
// review says what the chain will and will not learn, then RunProgress renders
// the live run through the shielded context.
import type { OpProgress } from "./ShieldedProvider";
import RunProgress from "./RunProgress";
import Spinner from "./Spinner";
import { TokenGlyph } from "./TokenModal";

type Props = {
  open: boolean;
  symbol: string;
  logoURI?: string;
  amount: string;
  /** Full zcowl address of the recipient. */
  to: string;
  /** True when the recipient is this account — a note moved to itself. */
  toSelf: boolean;
  progress: OpProgress | null;
  onExecute: () => void;
  onClose: () => void;
};

const STEPS = [
  { k: "Prove", d: "Your browser spends your notes inside the circuit and mints two fresh ones" },
  { k: "Submit", d: "The proof goes on chain and is checked there. Your old notes retire, fresh ones take their place" },
  { k: "Arrive", d: "Their view key opens their note and nothing else does. Change comes back to you" },
];

export default function SendConfirmModal({
  open,
  symbol,
  logoURI,
  amount,
  to,
  toSelf,
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
          <span className="label-mono text-[0.72rem] text-bone">Review send</span>
          {!running && (
            <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        {/* What moves, and where to */}
        <div className="px-5">
          <div className="bg-ink2 p-4 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={symbol} src={logoURI} />
              <span className="text-faint label-soft whitespace-nowrap">Shielded balance</span>
            </span>
            <span className="font-data text-lg text-bone whitespace-nowrap">
              {amount} {symbol}
            </span>
          </div>
          <div className="bg-ink2 p-4 mt-1">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-faint label-soft whitespace-nowrap">
                {toSelf ? "Your own address" : "Recipient"}
              </span>
              <span className="font-data text-lg text-acid whitespace-nowrap">
                {amount} {symbol}
              </span>
            </div>
            <code className="font-data text-[0.68rem] text-muted break-all leading-relaxed">{to}</code>
          </div>
        </div>

        {progress ? (
          /* ---- live run ---- */
          <div className="px-5 py-5 space-y-2">
            <RunProgress progress={progress} />

            {running && progress.step === "record" && (
              <p className="flex items-center gap-2 text-[0.7rem] text-muted leading-relaxed pt-1">
                <Spinner className="h-3 w-3 text-acid" />
                Reading the chain back. The payment has already landed.
              </p>
            )}
            {running && (
              <p className="text-[0.7rem] text-faint leading-relaxed pt-1">
                Keep this tab open until the transaction lands.
              </p>
            )}
            {progress.error && (
              <p className="text-xs text-[#ff6b6b] leading-relaxed pt-1">{progress.error}</p>
            )}
            {progress.done && (
              <p className="text-xs text-muted leading-relaxed pt-1">
                Sent. The recipient sees it the moment they scan for payments.
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
                  Sending…
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ---- review ---- */
          <div className="px-5 py-5 space-y-4">
            {STEPS.map((s, i) => (
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
              <span className="font-data text-muted text-right">two nullifiers, two commitments</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Amount</span>
              <span className="font-data text-acid text-right">never becomes public</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Wallet confirmations</span>
              <span className="font-data text-muted text-right">1</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Gas payer</span>
              <span className="font-data text-muted text-right">You</span>
            </div>

            <p className="text-[0.7rem] text-faint leading-relaxed">
              A payment is final the moment it lands. Check the address before you send: only its
              owner can spend what arrives there.
            </p>
            <button
              onClick={onExecute}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              Send now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
