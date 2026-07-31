# Security policy

This repository builds [app.cowlprotocol.com](https://app.cowlprotocol.com), the
browser client for the Cowl shielded pool on Robinhood Chain mainnet. It handles
real money, and it derives a spending key in the browser from a wallet
signature, so a flaw here can reach somebody's funds without the pool ever being
touched.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository: the **Security** tab, then **Report a vulnerability**. It is
private between you and the maintainers from the first message.

If that is unavailable, reach us on X at
[@cowlprotocoll](https://x.com/cowlprotocoll) and ask for a private channel. Send
the details only once one exists.

## What we commit to

- An acknowledgement that a human has read it, within **72 hours**.
- An assessment of impact and a plan, within **7 days**.
- Credit in the fix, if you want it, and none if you do not.
- No legal action against good-faith research that follows this policy.

We do not currently run a paid bounty. If that changes it will be announced
rather than negotiated per report.

## In scope

Anything that could:

- expose the unlock signature, the keys derived from it, or a decrypted note
- cause a spend to be built against the wrong recipient, amount, token or relayer
- get attacker-controlled code into the shipped bundle, including through a
  build-time dependency
- leak which shielded address belongs to which wallet, to us or to anyone else

The deployed contracts, the circuits and the CLI live in the `cli` repository and
carry [their own policy](https://github.com/Cowl-Protocol/cli/blob/main/SECURITY.md).

## Out of scope

- The chain, its RPC endpoints, and the block explorer
- Wallet extensions and WalletConnect itself
- Reports that dependencies carry published advisories, without an argument that
  one reaches the shipped bundle. That question has been answered once already,
  with evidence, in the cli repository's `audits/supplychain/README.md`
- Missing security headers on a static host, unless you can show what they let
  you do here

## Good-faith testing

Test against **Robinhood Chain testnet (46630)**. The network picker in the app
switches to it, both pools run the same code, and the testnet one holds no real
value. If a proof of concept genuinely requires mainnet, keep the amounts trivial
and tell us before, not after.

Do not test the relayer by exhausting its gas float. It is shared infrastructure
and draining it removes the gasless path for everyone.
