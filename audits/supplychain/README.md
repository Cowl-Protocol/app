# Supply chain — the app

The dependency gate for `Cowl-Protocol/app`, run 2026-08-01 against `0c2c364`.

The analysis of record for both repositories lives in the cli's
[`audits/supplychain/README.md`](https://github.com/Cowl-Protocol/cli/blob/main/audits/supplychain/README.md),
alongside the rest of the audit tree. This file is the app's half: what the gate
here checks, what is in this tree, and the verdict behind every line of
`baseline.json`.

| | |
|---|---|
| Scope | `package-lock.json` — 929 packages, 8 with install scripts, 27 advisories |
| Gate | `npm run test:supplychain`, and the `dependency gate` job on every push |
| Reproduce | `node audits/supplychain/check.mjs` |

## Why this repository needs its own gate

Everything a user of `app.cowlprotocol.com` runs was produced here. The site is a
static export, so **none of these 929 packages reaches a browser as itself** —
what reaches a browser is the bundle this tree builds. That is the whole point:
the risk is not that a dependency ships, it is that a dependency runs on the
machine doing the building, and the artifact it can edit is the one where a
wallet signature becomes a spending key.

The cli's gate reads the cli's lockfile. It has nothing to say about this one.

## What the gate checks

**Install scripts**, from the lockfile and nothing else — offline, so it cannot
fail for a reason unrelated to this repository. A package that gains one between
two releases is the whole modern supply-chain attack in a single event, and no
other control in either repository can see it.

**Advisories**, from `npm audit`, compared against a baseline where each entry
carries a written verdict. It degrades to exit 2 rather than reporting clean when
the registry does not answer.

**The twin.** The gate is byte-identical to the cli's copy and each baseline
records its sha256, so an edit on one side turns that repository red until
somebody re-records it — which is the moment to copy the change across. Compare
`twinSha` in the two baselines to know whether they are in sync.

Exit codes: **0** nothing new · **1** something new, or something the baseline
expects is gone · **2** could not check.

**Proven to fail**, on all three drift classes, then green again once restored:

| Injected | What the gate said |
|---|---|
| A package gains an install script | `zod 4.4.3 runs an install script and is not in the baseline (PRODUCTION)` |
| An accepted dev-only script moves into the production tree | `esbuild was a dev dependency and is now in the production tree` |
| The gate itself is edited | `this gate has been edited since it was recorded` |

## Install scripts — all eight

`optional` is recorded but never treated as safe: it means npm tolerates the
package failing, not that it declines to run it.

| Package | Where | Why it is accepted |
|---|---|---|
| `bufferutil` | prod tree, via viem → ws | Native speedup for a WebSocket implementation this app never opens. Build machine only |
| `utf-8-validate` | prod tree, via viem → ws | Same package, same path, same reasoning |
| `keccak` | prod tree, via wagmi → Coinbase Wallet SDK | Native hash used by a connector. Nothing shielded depends on it: Cowl's own hashing is Poseidon2 in the circuits and noble in the client |
| `msgpackr-extract` | prod tree, optional, via @aztec/bb.js → msgpackr | The one this repository shares with the cli, where it is also the only production install script. bb.js is the prover; the cli is proven to work with `--ignore-scripts` |
| `sharp` | prod tree, optional, via next | Image optimizer that is never invoked — see A-23 below |
| `esbuild` | dev | Bundler. Absent from anything a user loads |
| `unrs-resolver` | dev, via eslint-config-next | Lint-time module resolver |
| `fsevents` | dev, optional | macOS file watcher. Does not install on the Linux runner at all |

None of them reach a user, because a static export ships no Node process. All of
them run here, which is the point of watching them.

## Advisories — 27, every one with a verdict

Grouped by package, since the reasoning is per package rather than per CVE. The
per-advisory rows with IDs and links are in [`baseline.json`](baseline.json).

### The bundle evidence, and the control that makes it mean anything

Several verdicts below rest on a package being absent from what ships. **A grep
that returns zero proves nothing until the grep is proven**, so every sweep ran
with controls that must hit, over all 225 chunks in `out/_next/static/chunks/`:

| Searched | Chunks | |
|---|---|---|
| `axios` | 0 | |
| `new WebSocket` | 0 | |
| `brace-expansion` | 0 | |
| `libvips` | 0 | |
| `postcss` | 0 | |
| `sharp` | 0 | |
| `zcowl` | **3** | control — must hit |
| `shielded` | **12** | control — must hit |
| `WalletConnect` | **29** | control — must hit |
| `coinbase` | **26** | control — must hit |

`coinbase` at 26 beside `axios` at 0 is the precise result rather than a lucky
one: the connector ships, and the path through it that would pull axios does not.

### next — 10 advisories

Every one needs a **running Next server**: middleware, Server Actions, rewrites,
the response cache, the Image Optimization API, or Server Function endpoints.
There is no Next server in production. `output: "export"` emits static files that
Caddy serves from a web root.

Proven in the tree rather than assumed: no `middleware.ts`, zero occurrences of
`"use server"`, and zero route handlers.

### axios — 10 advisories

Reached under `@wagmi/connectors` → `@base-org/account` → `@coinbase/cdp-sdk`, a
wallet this app does not offer. `next.config.ts` aliases `@base-org/account` to
an empty stub, and the bundle sweep puts axios in 0 chunks.

### sharp — 1 advisory (A-23)

Inherited libvips CVEs, reached only through next's image optimization.
`images: { unoptimized: true }`, zero `next/image` imports, and sharp is a Node
native module that cannot enter a browser bundle in the first place.

### postcss — 3 advisories

Build-time CSS transformation, from Tailwind and from next. Both advisories need
attacker-controlled CSS — a hostile `sourceMappingURL` comment, or unescaped
`</style>` reaching stringify — and the CSS here is ours.

### ws — 2 advisories

viem's Node WebSocket implementation, reached through `isows`, which resolves to
the browser's native WebSocket in a browser build. This app talks to the chain
over HTTP RPC and opens no socket: `new WebSocket` is in 0 chunks.

### uuid — 1 advisory

**The one package in this list that does ship**, in 5 chunks, under wagmi →
`@metamask/utils`. The advisory is a missing buffer bounds check in `v3`, `v5`
and `v6` *when a `buf` argument is passed*. That consumer calls `v4()` and
nothing else, and the DNS and URL namespace constants that v3 and v5 require
appear in 0 chunks — so the affected variants are not merely unused, they are
not present.

### brace-expansion — 1 advisory

Under `eslint-config-next` → `typescript-eslint` → `minimatch`. Lint-time, absent
from the production tree, absent from the bundle.

## Not yet done

- **The advisories are rebutted, not closed.** Bumping Next.js would close ten of
  them outright. That is a real change with a real regression surface across the
  proving worker and the static export, so it is deliberate work rather than
  something to fold into this step.
- **No provenance on the artifact.** The bundle is built here and rsynced to the
  VPS by hand. Nothing signs it, and nothing lets a visitor check that the
  JavaScript they received is the JavaScript this repository builds. That is the
  gap this whole page argues matters most, and it is the natural next step.
- **Socket is not installed.** A GitHub App, so only the account owner can add
  it.
