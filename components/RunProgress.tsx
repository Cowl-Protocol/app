"use client";

// The live half of every execution modal: one row per part, each showing where
// that part is right now and its transaction once it lands.
//
// Shared by the boundary (which can run many parts behind a spread) and by a
// private send (always a single one), so the two never drift into describing
// the same step with different words.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { activeNetwork } from "@/lib/networks";
import { formatRemaining } from "@/lib/spread";
import type { OpProgress, OpStep } from "./ShieldedProvider";
import Spinner from "./Spinner";

const STEP_LABEL: Record<OpStep, string> = {
  unlock: "sign to unlock in your wallet",
  wait: "waiting",
  sync: "reading the chain",
  prove: "proving in your browser",
  confirm: "confirm in your wallet",
  mined: "landed",
  record: "filing your note",
};

/**
 * The submit step reads differently depending on who is carrying it. Relayed,
 * no wallet ever opens — telling someone to confirm in theirs would leave them
 * waiting on a prompt that is never coming, which is the one thing a progress
 * row must not do. The run republishes `relayed` per part, so this follows a
 * relayer that drops out mid-run.
 */
function stepLabel(progress: OpProgress): string {
  if (progress.step === "confirm" && progress.relayed) return "the relayer is submitting";
  return STEP_LABEL[progress.step];
}

export default function RunProgress({ progress }: { progress: OpProgress }) {
  const [, tick] = useState(0);

  // A visible countdown needs a local heartbeat; the value it renders still
  // comes from the end time the run published, never from counting frames.
  const waitUntil = progress.waitUntil;
  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [waitUntil]);

  const net = activeNetwork();
  // Eight fraction digits on screen, the exact figure in the tooltip. A trade
  // output carries all eighteen, and at full width it shoved the status text
  // into a ragged wrap around the spinner.
  const fmtPart = (v: bigint, decimals: number) => {
    const [i, f = ""] = formatUnits(v, decimals).split(".");
    const ff = f.slice(0, 8).replace(/0+$/, "");
    return ff ? `${i}.${ff}` : i;
  };

  return (
    <>
      {progress.parts.map((p, i) => {
        const unit = progress.partUnits?.[i] ?? { symbol: progress.symbol, decimals: progress.decimals };
        const tx = progress.txs.find((t) => t.part === i);
        // Filing happens after the money has moved, so the row keeps its hash
        // and the footer carries the fact that work is still going.
        const isCurrent =
          i === progress.current && !progress.done && !progress.error && progress.step !== "record";
        const isDone = !!tx;
        const failedHere = !!progress.error && i === progress.current;
        return (
          <div key={i} className="bg-ink2 px-4 py-3 flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
            <span className="flex items-center gap-3 min-w-0">
              <span
                className={`shrink-0 h-6 w-6 flex items-center justify-center label-mono text-[0.62rem] ${
                  isDone ? "bg-acid text-ink" : failedHere ? "bg-[#3a1414] text-[#ff6b6b]" : "bg-ink3 text-acid"
                }`}
              >
                {isDone ? "✓" : i + 1}
              </span>
              <span
                className="font-data text-sm text-bone whitespace-nowrap"
                title={formatUnits(p, unit.decimals)}
              >
                {fmtPart(p, unit.decimals)} {unit.symbol}
              </span>
            </span>
            <span className="text-right ml-auto whitespace-nowrap">
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
                  <Spinner className="h-3 w-3 mr-2 align-middle text-acid" />
                  {progress.step === "wait" && progress.waitUntil
                    ? `firing in ${formatRemaining(progress.waitUntil - Date.now())}`
                    : stepLabel(progress)}
                </span>
              ) : (
                <span className="font-data text-xs text-faint">waiting</span>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
