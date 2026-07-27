"use client";

import type { Token } from "@/lib/tokens";
import { TokenGlyph } from "./TokenModal";

type Props = {
  open: boolean;
  pay: Token;
  receive: Token;
  amount: string;
  out: string;
  minReceived: string;
  relay?: string;
  onClose: () => void;
};

const STEPS = [
  { k: "Prove", d: "Prove the spend inside the circuit. No wallet, no amount revealed" },
  { k: "Route", d: "Relayer submits the swap and pays gas" },
  { k: "Re-shield", d: "What you receive lands back in your shielded balance" },
];

export default function ConfirmModal({
  open,
  pay,
  receive,
  amount,
  out,
  minReceived,
  relay,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md bg-card fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">Review private swap</span>
          <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
            ✕
          </button>
        </div>

        {/* Amounts */}
        <div className="px-5">
          <div className="bg-ink2 p-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={pay.symbol} />
              <span className="text-faint label-soft">You pay</span>
            </span>
            <span className="font-data text-lg text-bone">
              {amount} {pay.symbol}
            </span>
          </div>
          <div className="h-px" />
          <div className="bg-ink2 p-4 flex items-center justify-between mt-1">
            <span className="flex items-center gap-2">
              <TokenGlyph symbol={receive.symbol} />
              <span className="text-faint label-soft">You receive</span>
            </span>
            <span className="font-data text-lg text-acid">
              ≈ {out} {receive.symbol}
            </span>
          </div>
        </div>

        {/* Plan */}
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
            <span className="text-faint font-data">Min. received</span>
            <span className="font-data text-muted">
              {minReceived} {receive.symbol}
            </span>
          </div>
          {relay && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint font-data">Relayer</span>
              <span className="font-data text-acid">{relay.replace("https://", "")}</span>
            </div>
          )}
        </div>

        {/* A review, not a run. The card behind this one is still gated, so the
            panel shows what a private swap does and stops there. */}
        <div className="px-5 pb-5">
          <button
            onClick={onClose}
            className="w-full label-mono text-sm py-4 bg-ink3 text-muted hover:text-bone transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
