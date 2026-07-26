"use client";

// A payment address as something a phone can read.
//
// Rendered as SVG rather than canvas so it stays sharp at any size and needs no
// ref, no device-pixel-ratio maths and no second paint. The whole code is one
// <path>: a rect per module would be sixteen hundred DOM nodes for something
// that never changes.
import { useMemo } from "react";
import encodeQR from "qr";

/**
 * The white plate and the margin around the code are not styling. Scanners look
 * for a quiet zone to find the code's edges, and they expect dark modules on
 * light — inverted or flush to the edge, plenty of phones simply never lock on.
 * So this stays light even though everything around it is dark.
 *
 * The encoder draws the quiet zone itself, so the matrix it returns already
 * includes it. Adding another one here, as this did, only padded the code with
 * six modules of margin where the standard asks for four.
 */
const QUIET = 4;

export default function QrCode({
  text,
  size = 184,
  className = "",
}: {
  text: string;
  size?: number;
  className?: string;
}) {
  const { path, span } = useMemo(() => {
    // bech32 is case-insensitive and its spec asks for upper case here: an
    // all-caps payload encodes in QR's alphanumeric mode instead of byte mode,
    // which takes this address from a 49-module code to a 41-module one. Both
    // decoders accept either case, so nothing downstream notices.
    const modules = encodeQR(text.toUpperCase(), "raw", { border: QUIET }) as boolean[][];
    const n = modules.length;
    let d = "";
    for (let y = 0; y < n; y++) {
      const row = modules[y]!;
      // Merge each run of dark modules into one horizontal stroke — fewer,
      // larger shapes also mean no hairline seams between neighbours.
      let x = 0;
      while (x < n) {
        if (!row[x]) {
          x++;
          continue;
        }
        let run = 1;
        while (x + run < n && row[x + run]) run++;
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run;
      }
    }
    return { path: d, span: n };
  }, [text]);

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label="Your shielded payment address as a QR code"
    >
      <rect width={span} height={span} fill="#f4f4ef" />
      <path d={path} fill="#0a0b0e" />
    </svg>
  );
}
