// QR-check: the payment address survives the round trip through the code we
// draw. Run with:  npx tsx scripts/qrcheck.mts
//
// Encoding a QR is easy to do wrong in ways that still produce a picture: a
// missing quiet zone, an off-by-one in the run-length path, a transposed
// matrix. So this rebuilds the exact bitmap the component draws — from the SVG
// path, not from the library's matrix — and hands it to a decoder. What passes
// here is what a phone camera sees.
import encodeQR from "qr";
import decodeQR from "qr/decode.js";
import { Bitmap } from "qr";
import { deriveShieldedKeysFromSignature, decodePaymentAddress } from "../lib/shielded/keys";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const QUIET = 4;

/** The component's path builder, verbatim — this is the thing under test. */
function buildPath(modules: boolean[][]): string {
  const n = modules.length;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = modules[y]!;
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
  return d;
}

/** Replay the path back into a grid, the way a renderer would fill it. */
function rasterise(path: string, span: number): boolean[][] {
  const grid = Array.from({ length: span }, () => new Array<boolean>(span).fill(false));
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const x = Number(m[1]), y = Number(m[2]), run = Number(m[3]);
    for (let i = 0; i < run; i++) grid[y]![x + i] = true;
  }
  return grid;
}

const addr = deriveShieldedKeysFromSignature("0x" + "9c".repeat(65)).paymentAddress;
const payload = addr.toUpperCase();

const modules = encodeQR(payload, "raw", { border: QUIET }) as boolean[][];
check("address is bech32m", /^zcowl1[02-9ac-hj-np-z]+$/.test(addr), `${addr.length} chars`);
check(
  "upper case is the denser encoding",
  modules.length < (encodeQR(addr, "raw", { border: QUIET }) as boolean[][]).length,
  `${modules.length} vs ${(encodeQR(addr, "raw", { border: QUIET }) as boolean[][]).length} modules`,
);

// The encoder's matrix already carries the quiet zone, so the drawn span is it.
const span = modules.length;
const grid = rasterise(buildPath(modules), span);
check(
  "drawn grid carries exactly one quiet zone",
  grid[0]!.every((v) => !v) && grid.every((r) => !r[0]) && grid[QUIET]!.slice(QUIET).some((v) => v),
  `${QUIET} modules`,
);
check(
  "drawn grid matches the encoder's matrix",
  modules.every((row, y) => row.every((v, x) => grid[y]![x] === v)),
);

// Decode what we drew, not what we were given.
// Scaled up, because a decoder looks for the finder patterns in pixels and a
// one-pixel-per-module image gives it nothing to lock on to — the same reason
// a QR printed too small never scans.
const bitmap = new Bitmap({ width: span, height: span });
for (let y = 0; y < span; y++) for (let x = 0; x < span; x++) bitmap.set(x, y, grid[y]![x]!);
const decoded = decodeQR(bitmap.scale(4).toImage() as never);
check("a scanner reads the address back", decoded === payload, decoded === payload ? "" : `got ${String(decoded).slice(0, 24)}…`);
check(
  "what it reads decodes to the same account",
  decodePaymentAddress(String(decoded)).mpk === decodePaymentAddress(addr).mpk,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
