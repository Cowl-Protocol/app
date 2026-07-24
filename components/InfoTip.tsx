"use client";

import { useEffect, useRef, useState } from "react";

/** Tiny info marker beside a term — hover or tap explains it in place. */
export default function InfoTip({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <span
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="What is this?"
        onClick={() => setOpen((o) => !o)}
        className={`h-3.5 w-3.5 rounded-full flex items-center justify-center text-[0.55rem] font-data leading-none transition-colors ${
          open ? "bg-acid text-ink" : "bg-ink3 text-faint hover:text-bone"
        }`}
      >
        !
      </button>
      {open && (
        <span
          className={`absolute top-5 z-40 block w-56 bg-ink3 p-3 text-xs text-muted leading-relaxed whitespace-normal normal-case tracking-normal text-left font-sans fade-up ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
