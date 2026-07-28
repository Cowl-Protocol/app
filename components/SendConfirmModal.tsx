"use client";

// Review-and-execute for a private send. One transaction, no public leg: the
// review says what the chain will and will not learn, then RunProgress renders
// the live run through the shielded context.
import { trimDecimals } from "@/lib/prices";
import type { OpProgress } from "./ShieldedProvider";
import ErrorNotice from "./ErrorNotice";
import RunProgress from "./RunProgress";
import Spinner from "./Spinner";
import { TokenGlyph } from "./TokenModal";

type Props = {
  open: boolean;
  symbol: string;
  logoURI?: string;
  amount: string;
  /** What the amount is worth, or null when the token has no price. */
  usd: string | null;
  /** Full zcowl address of the recipient. */
  to: string;
  /** True when the recipient is this account — a note moved to itself. */
  toSelf: boolean;
  /** A relayer is carrying this payment, so no wallet confirmation comes. */
  gasless?: boolean;
  /** Its fee, already formatted with the symbol. */
  relayFee?: string;
  /** What leaves the shielded book in total: the payment plus that fee. */
  drawn?: string;
  /** Self-paid: the estimated gas the wallet is about to pay, formatted. */
  networkFee?: string;
  progress: OpProgress | null;
  onExecute: () => void;
  onClose: () => void;
};

const STEPS = (gasless: boolean) => [
  { k: "Prove", d: "Your browser spends your notes inside the circuit and mints two fresh ones" },
  {
    k: "Submit",
    d: gasless
      ? "The relayer puts the proof on chain and pays for it. Your old notes retire, fresh ones take their place"
      : "The proof goes on chain and is checked there. Your old notes retire, fresh ones take their place",
  },
  { k: "Arrive", d: "Their view key opens their note and nothing else does. Change comes back to you" },
];

export default function SendConfirmModal({
  open,
  symbol,
  logoURI,
  amount,
  usd,
  to,
  toSelf,
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
            {/* The dollar figure belongs on the last screen before signing, not
                only on the one where the number was typed. */}
            <span className="text-right whitespace-nowrap">
              <span className="font-data text-lg text-bone" title={`${amount} ${symbol}`}>
                {trimDecimals(amount)} {symbol}
              </span>
              {usd && <span className="block font-data text-[0.7rem] text-faint">{usd}</span>}
            </span>
          </div>
          <div className="bg-ink2 p-4 mt-1">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-faint label-soft whitespace-nowrap">
                {toSelf ? "Your own address" : "Recipient"}
              </span>
              <span className="font-data text-lg text-acid whitespace-nowrap" title={`${amount} ${symbol}`}>
                {trimDecimals(amount)} {symbol}
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
                Stay on this tab until the transaction lands.
              </p>
            )}
            {progress.error && (
              <div className="pt-1">
                <ErrorNotice message={progress.error} detail={progress.errorDetail} />
              </div>
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
                  <span className="flex items-center justify-center gap-2">
                    <Spinner className="h-3 w-3" />
                    Sending
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
              <span className="font-data text-muted text-right">two nullifiers, two commitments</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Amount</span>
              <span className="font-data text-acid text-right">never becomes public</span>
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
            {gasless && drawn && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Drawn from your balance</span>
                <span className="font-data text-acid text-right">{drawn}</span>
              </div>
            )}
            {!gasless && networkFee && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-faint font-data">Network fee</span>
                <span className="font-data text-muted text-right">{networkFee}</span>
              </div>
            )}

            {gasless ? (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                The relayer submits and pays the gas, so the chain records it and not your wallet.
                Its fee is bound into the proof before anything moves, and it comes out of the notes
                you are spending rather than the payment — the recipient is paid in full.
              </p>
            ) : (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                Your wallet submits this spend and pays its gas, so the chain records it as the
                caller. Nothing is drawn from your notes but the payment itself, and the amount and
                the recipient stay hidden either way.
              </p>
            )}
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
