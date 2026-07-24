"use client";

import { useEffect, useRef, useState } from "react";
import { NETWORKS } from "@/lib/networks";

// Mainnet isn't live for Cowl yet — only the testnet pool is deployed, so it's the
// single selectable option and mainnet is shown disabled until the pool ships there.
const OPTIONS = [
  { key: "robinhood-testnet", name: "Robinhood Chain", tag: "Testnet", live: true },
  { key: "robinhood-mainnet", name: "Robinhood Chain", tag: "Mainnet", live: false },
];

export default function NetworkSelect() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("robinhood-testnet");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const current = OPTIONS.find((o) => o.key === active) ?? OPTIONS[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 label-mono text-[0.72rem] text-muted hover:text-bone px-5 py-2.5 bg-[#1c2027] hover:bg-[#242932] transition-colors"
      >
        <span className="text-bone">{current.name}</span>
        <span className="text-acid">{current.tag}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-30 w-60 bg-card fade-up">
          <p className="label-mono text-[0.6rem] text-faint px-4 pt-3 pb-2">Network</p>
          {OPTIONS.map((o) => {
            const selected = o.key === active;
            return (
              <button
                key={o.key}
                disabled={!o.live}
                onClick={() => {
                  if (!o.live) return;
                  setActive(o.key);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                  o.live ? "hover:bg-ink3" : "opacity-45 cursor-not-allowed"
                }`}
              >
                <span className="flex flex-col">
                  <span className="label-mono text-[0.72rem] text-bone">{o.tag}</span>
                  <span className="text-[0.68rem] text-faint">{o.name}</span>
                </span>
                {o.live ? (
                  selected ? (
                    <span className="label-mono text-[0.58rem] text-acid">Live</span>
                  ) : (
                    <span className="label-mono text-[0.58rem] text-muted">Select</span>
                  )
                ) : (
                  <span className="label-mono text-[0.58rem] text-faint bg-ink2 px-2 py-0.5">Soon</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-bone transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
