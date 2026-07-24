// Bundle the prove worker to /public as plain browser ESM, outside the app
// bundler entirely. Turbopack treats `new Worker(new URL(...))` as a raw asset
// copy (the worker arrived as an uncompiled .ts file), so the worker is built
// here with esbuild instead and the page loads it from a stable path.
//
// Three entries, because bb.js spawns nested workers of its own with
// `new URL('./x.worker.js', import.meta.url)` — inside a bundle that resolves
// against the bundle's own URL, so those two land beside it at the web root.
// The noir wasm-bindgen packages resolve their .wasm the same way, so both
// wasm files are copied beside the bundle under their exact names.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public");
mkdirSync(out, { recursive: true });

const BB = join(root, "node_modules/@aztec/bb.js/dest/browser");

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "error",
  alias: {
    // Their package mains point at the node builds; the web builds are what
    // runs here.
    "@noir-lang/acvm_js": join(root, "node_modules/@noir-lang/acvm_js/web/acvm_js.js"),
    "@noir-lang/noirc_abi": join(root, "node_modules/@noir-lang/noirc_abi/web/noirc_abi_wasm.js"),
  },
};

await build({
  ...common,
  entryPoints: [join(root, "lib/shielded/proveWorker.ts")],
  outfile: join(out, "prove-worker.js"),
});

await build({
  ...common,
  entryPoints: [join(BB, "barretenberg_wasm/barretenberg_wasm_main/factory/browser/main.worker.js")],
  outfile: join(out, "main.worker.js"),
});

await build({
  ...common,
  entryPoints: [join(BB, "barretenberg_wasm/barretenberg_wasm_thread/factory/browser/thread.worker.js")],
  outfile: join(out, "thread.worker.js"),
});

copyFileSync(
  join(root, "node_modules/@noir-lang/acvm_js/web/acvm_js_bg.wasm"),
  join(out, "acvm_js_bg.wasm"),
);
copyFileSync(
  join(root, "node_modules/@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm"),
  join(out, "noirc_abi_wasm_bg.wasm"),
);

console.log("prove worker bundled to public/");
