# Cowl App — app.cowlprotocol.com

The Cowl trading dapp. A Uniswap-style swap interface that routes through the
shielded pool on Robinhood Chain — private trades where your wallet never
appears as the counterparty.

## Stack

- Next.js 16 (App Router, Turbopack) · React 19 · Tailwind v4
- viem for wallet connect (injected EIP-1193) and chain reads
- Cowl brand system: Amoria (display) · Tronica Mono (labels/numbers) · Geist (body)

## Run

```bash
npm install
npm run dev      # http://localhost:3001
```

Runs on port 3001 so it can sit alongside the marketing site (`../cowl`, port 3000).

## Structure

```
app/
  layout.tsx        fonts + metadata
  globals.css       Cowl theme tokens (@theme)
  page.tsx          shell: header + hero + swap card
components/
  Header.tsx        logo, nav, network badge, connect button
  SwapCard.tsx      the swap interface (pay / receive / flip / rate / privacy rows)
  TokenModal.tsx    token selector
  ConfirmModal.tsx  private-trade plan + CLI hand-off
  ConnectButton.tsx wallet connect states
lib/
  networks.ts       Robinhood Chain testnet/mainnet defs + contract addresses
  tokens.ts         token list (ETH · WETH · USDG · COWL)
  useWallet.ts      connect / switch-chain / balance hook (viem)
```

## Wiring status

- **Live:** wallet connect, network detect + add/switch to Robinhood testnet,
  on-chain ERC-20 / native balances, real contract addresses from the CLI.
- **Indicative:** swap quotes use USD anchors — the on-chain quoter drops into
  `SwapCard` (`lib/networks.ts` → `contracts.quoter`) when routing is wired.
- **CLI hand-off:** shielded proofs run locally today, so the confirm sheet hands
  off to `cowl trade …`. In-browser proving lands later.

Addresses and network config mirror `cli/src/networks.ts` — keep them in sync.
