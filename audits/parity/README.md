# Parity — this port against the CLI

The browser client is a second implementation of the shielded core. It derives
the same keys, builds the same notes, hashes the same tree and writes into the
same pool as `@cowlprotocol/cli`, from its own copy of the code.

Two implementations sharing one pool is either the strongest check in this
protocol or its quietest failure. If they agree, every property they agree on
was computed twice by different code. If they drift, the app builds witnesses
the pool rejects — or, worse, ones it accepts against a root nobody else has.

`scripts/crosscheck.mts` is the check. This is what it now covers and what an
agreement is actually worth.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in the
[audit index](https://github.com/Cowl-Protocol/cli/blob/main/audits/README.md).

| | Check | Result 2026-08-01 |
|---|---|---|
| 🟢 | Field and note math agree | 320 vectors each for poseidon arity 2 and 4, commitment, nullifier |
| 🟢 | Note ciphers interoperate both ways | 38 notes, each encrypted on one side and read on the other |
| 🟢 | Packed cipher length is constant | 318 chars for every value from 0 to `FR - 1` |
| 🟢 | Merkle roots agree across tree shapes | 12 sizes, empty through 33 leaves |
| 🟢 | Merkle paths identical, and each port verifies the other's | every index of every size |
| 🟢 | The insertion witness holds both walks | the property the circuit's double walk rests on |
| 🟢 | Signature-derived keys are one account in both clients | address, `mpk`, view key and space all match |
| 🟢 | The checks can fail | 4 mutations, 4 caught |
| 🟢 | Runs on every push | new `parity` job, both repositories checked out |
| 🟡 | Independence varies by module | stated per module below rather than implied |

**No 🔴.**

```
npx tsx scripts/crosscheck.mts --offline    # parity only, ~4s, what CI runs
npx tsx scripts/crosscheck.mts              # adds the mainnet replay and a real proof
CROSSCHECK_SAMPLES=4096 npx tsx scripts/crosscheck.mts --offline
```

## What an agreement is worth, per module

The strength of a differential test is the independence of the two sides. That
varies here, so it is written down instead of left to be assumed by whoever
reads a green run.

| Module | Independence | So a green run means |
|---|---|---|
| `crypto` | **real** — `@noble/ciphers` here, `node:crypto` there | two separate AES-GCM implementations produce the same bytes and read each other. Evidence. |
| `field` | shared Poseidon2 primitive | the wiring around the hash agrees. Not a check of the hash itself — that is pinned separately by `circuits/poseidon-parity` |
| `note`, `keys` | ported by hand, diverge in their token tables | the encodings agree where both sides encode |
| `tree` | **the same code today**, modulo one import extension | a drift alarm, not a proof |

The tree row is the one to be honest about. Two identical files cannot disagree,
so today that check proves nothing about correctness. It earns its place the day
somebody edits one copy and not the other, which is precisely how a browser
client starts building witnesses the pool will not accept, and it is now wired to
fail on the push that does it rather than on a user's balance.

## The sweeps

Every parity check used to draw **one random sample per run**. One sample proves
the two ports agree at one point, and the disagreements worth finding do not live
at a random point. They live at zero, at one, at the top of the field, and at the
128-bit limb boundary every packed encoding in this protocol splits on.

Each property now runs a fixed edge set — `0`, `1`, `2`, `FR-1`, `FR-2`,
`2^128-1`, `2^128`, `2^252` in every pair — plus `CROSSCHECK_SAMPLES` random
vectors, default 256. The vector count is printed on every line, so a sweep that
quietly stopped sweeping is visible rather than green.

### The tree, which had nothing

The Merkle tree is the accumulator every spend proves membership under, and it
had no cross-check at all. It now has three.

**Roots across twelve shapes** — empty, one leaf, exact powers of two, and the
odd counts that force the zero-sibling branch at more than one level.

**Every path index of every shape**, not a sampled one: the sibling that is a
zero subtree only appears at particular indices, and those are the interesting
ones. Each port must also *verify the other's proof*, which is the property a
shared root actually rests on.

**Both walks of the insertion witness.** `appendProof` reads the path at the
empty slot the leaf is about to occupy, so walking those siblings with a zero
leaf must reproduce the root the chain holds right now, and walking them with the
real leaf must produce the root it moves to. That double walk is what the pool
proves in circuit instead of hashing Poseidon2 on chain. If it stops holding, the
app builds insertion proofs against a root the pool does not have.

### The one that guards a leak rather than a divergence

AES-GCM ciphertext is exactly as long as its plaintext, so the payload's encoding
is itself a side channel: an encoding that is a byte shorter for a smaller number
publishes the size of the amount to anyone reading the pool's events.
`crypto.ts` already carries a comment about that bug because it has happened
here. The sweep now asserts the packed length is **identical for every value
from 0 to `FR - 1`**, which is the check that catches it coming back.

## Proven able to fail

Four mutations, applied to the app's port one at a time, each restored
immediately after:

| Mutation | Caught by |
|---|---|
| pad an odd level with the wrong zero subtree — `ZEROS[d+1]` for `ZEROS[d]` | `root parity across tree shapes`, at size 1 |
| report the wrong side at each level of the append witness | `insertion witness holds both walks` |
| always claim to be the left child in a Merkle path | `merkle paths identical and cross-verified`, at size 2 index 1, and the insertion walk |
| drop the fixed-width payload encoding, so the cipher shortens for small values | the cipher section, loudly |

A fifth was tried and **survived, correctly**: padding `appendProof`'s working
array with a second explicit zero leaf. That is not a defect. An unwritten slot
and an explicit zero hash the same — `ZEROS[0]` is 0 — which is exactly why one
path serves both walks, and a check that failed on it would be checking the
implementation rather than the property.

## One throw no longer hides the rest

Every block in the script sat at the top level, so the first exception ended the
run and every check after it went unreported. The fourth mutation above found
that: a malformed cipher threw inside the interop block, and the log stopped
there with the tree section never having run — looking, to a reader, like the
tree had never been in doubt.

Each section is now wrapped. A throw is a named failure and the rest still run.

## On every push

`--offline` drops the live mainnet replay and the bb.js proof, leaving about
four seconds of pure parity. That answered one of the two reasons this had never
been in CI; the other was that it imports from `../../cli`, which a clone of this
repository alone does not have.

The new `parity` job checks out both repositories. **A change on the CLI's main
can now turn this red without a commit here**, and that is correct rather than a
flaw: the two implementations sharing a pool is the invariant, whichever side
moves first is the side that broke it, and finding out on a push is the whole
point. Pinning the CLI to a fixed commit would keep this green while the app
built witnesses the live pool rejects.

The two halves left out of CI stay out, for reasons that have not changed: the
mainnet replay reads the chain, so it fails for reasons unrelated to the commit
under test, and the shield proof loads the WASM backend and takes minutes. Both
still run in the manual pre-release pass.

## Not covered

- **The proving pipeline is only checked for shape.** The full run asserts a
  shield proof comes back with six public inputs and a plausible length. It does
  not verify that proof against the on-chain verifier, which is where a real
  end-to-end parity claim would end.
- **`tradecheck` still imports the CLI and is still out of CI.** The same
  two-checkout job would carry it; it was left alone because it also needs a
  venue.
- **Nothing sweeps `pool.ts` or `sync.ts`.** Scanning, note selection and merge
  rounds are checked by the app's own offline suite against its own expectations,
  not against the CLI's.
