"use client";

import { useState } from "react";
import MaskLogo from "./MaskLogo";

export default function Banner() {
  const [show, setShow] = useState(true);
  if (!show) return null;

  return (
    <div className="w-full bg-[#161a10] text-bone">
      <div className="relative px-6 md:px-10 py-2.5 flex items-center justify-center gap-3 text-center">
        <MaskLogo className="h-2.5 w-auto text-acid shrink-0" />
        <p className="label-mono text-[0.62rem] leading-relaxed">
          <span className="text-acid">Live</span>
          <span className="text-muted"> · Shield, unshield and private payments run in your browser now. Your keys never leave the tab. </span>
          <a
            href="/shield"
            className="text-bone hover:text-acid transition-colors"
          >
            Open the shield →
          </a>
        </p>
        <button
          onClick={() => setShow(false)}
          aria-label="Dismiss"
          className="absolute right-4 md:right-6 text-faint hover:text-bone text-sm leading-none"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
