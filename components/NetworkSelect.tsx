"use client";

import { useEffect, useRef, useState } from "react";
import { activeNetwork, DEFAULT_NETWORK, setActiveNetwork } from "@/lib/networks";

// Both networks are live: the testnet pool since Feb 2026 and the mainnet pool
// since Jul 24 2026. The choice persists per browser and a reload re-derives
// every module (RPC, addresses, token list) from it.
const OPTIONS = [
  { key: "robinhood-mainnet", name: "Robinhood Chain", tag: "Mainnet" },
  { key: "robinhood-testnet", name: "Robinhood Chain", tag: "Testnet" },
];

export default function NetworkSelect() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(DEFAULT_NETWORK);
  const ref = useRef<HTMLDivElement>(null);

  // Read the stored choice after mount so server and first client render agree.
  useEffect(() => {
    setActive(activeNetwork().key);
  }, []);

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
          <p className="label-soft text-faint px-4 pt-3 pb-2">Network</p>
          {OPTIONS.map((o) => {
            const selected = o.key === active;
            return (
              <button
                key={o.key}
                onClick={() => {
                  setOpen(false);
                  if (!selected) setActiveNetwork(o.key);
                }}
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-ink3"
              >
                <span className="flex flex-col">
                  <span className="label-mono text-[0.72rem] text-bone">{o.tag}</span>
                  <span className="text-[0.68rem] text-faint">{o.name}</span>
                </span>
                {selected ? (
                  <span className="label-soft text-acid">Active</span>
                ) : (
                  <span className="label-soft text-muted">Select</span>
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
