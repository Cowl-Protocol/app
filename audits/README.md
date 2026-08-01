# Audits — the browser client

The reports that cover this repository. The protocol-wide tracker lives in the
CLI repo and is the index of record for everything:
**[Cowl-Protocol/cli · audits/README.md](https://github.com/Cowl-Protocol/cli/blob/main/audits/README.md)**.
Severity, status vocabulary and the colour scale are all defined there, so a
finding here means the same thing a finding there does.

Read that first. This file exists because two reports live in this repository
rather than that one, and a reader who arrives here should not have to guess
whether that is everything.

| | Area | Where it stands | Report |
|---|---|---|---|
| 🟢 | Two clients, one pool | This port and the CLI compute the same numbers: field, note, cipher, key and Merkle parity, swept over edge vectors and gated on every push | [parity/](parity/README.md) |
| 🟢 | Supply chain | 929 packages, 8 install scripts and 27 advisories each with a written verdict, none reachable, gated against a baseline | [supplychain/](supplychain/README.md) |

**Everything else that covers this code is reported in the CLI repo**, because
the work was done across both trees at once and splitting a report in half would
make neither half readable:

- **CodeQL** `security-extended` over 76 files here — [codeql/](https://github.com/Cowl-Protocol/cli/blob/main/audits/codeql/README.md)
- **Continuous integration**, all three jobs in this repository — [ci/](https://github.com/Cowl-Protocol/cli/blob/main/audits/ci/README.md)
- **Scorecard**, this repository scored 8.0 — [supplychain/](https://github.com/Cowl-Protocol/cli/blob/main/audits/supplychain/README.md)

## What runs here

```
npm run test:offline                          # eight source-property checks, no network
npm run test:supplychain                       # the dependency gate

npx tsx scripts/crosscheck.mts --offline       # parity with the CLI, ~4s
npx tsx scripts/tradecheck.mts --offline       # the trade plan and its wire format
```

The three above the blank line and both `--offline` runs are what CI gates. The
full `crosscheck` and `tradecheck` add a live chain read and, for crosscheck, a
real proof; those stay in the manual pre-release pass because they fail for
reasons that have nothing to do with the commit under test.

## Reporting something

[`../SECURITY.md`](../SECURITY.md). Private disclosure, 72 hours to an
acknowledgement from a human, and no paid programme yet — the scope for one is
drafted at
[audits/bounty/](https://github.com/Cowl-Protocol/cli/blob/main/audits/bounty/README.md).
