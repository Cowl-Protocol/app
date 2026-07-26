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
  sync: "syncing the pool",
  prove: "proving in your browser",
  confirm: "confirm in your wallet",
  mined: "landed",
  record: "filing your note",
};

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
  const fmtPart = (v: bigint) => {
    const s = formatUnits(v, progress.decimals);
    return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };

  return (
    <>
      {progress.parts.map((p, i) => {
        const tx = progress.txs.find((t) => t.part === i);
        // Filing happens after the money has moved, so the row keeps its hash
        // and the footer carries the fact that work is still going.
        const isCurrent =
          i === progress.current && !progress.done && !progress.error && progress.step !== "record";
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
                  <Spinner className="h-3 w-3 mr-2 align-middle text-acid" />
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
    </>
  );
}
