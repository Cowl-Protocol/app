"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type Token } from "@/lib/tokens";
import { decompose, groupParts, MAX_BOUNDARY_TXS, tiersFor } from "@/lib/denominations";
import { USD } from "@/lib/prices";
import type { useWallet } from "@/lib/useWallet";
import BoundaryConfirmModal, { type BoundaryMode } from "./BoundaryConfirmModal";
import TokenModal, { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";

type WalletState = ReturnType<typeof useWallet>;

// Curated boundary list — the pool takes any ERC-20, so the modal also imports
// a pasted contract address (tokenized stocks and the rest of Robinhood's RWAs).
const BOUNDARY_TOKENS = [tokenBySymbol("ETH"), tokenBySymbol("WETH"), tokenBySymbol("USDG")];

const SPREADS = ["45s", "20m", "3h"] as const;

function fmtUnits(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export default function ShieldCard({ wallet }: { wallet: WalletState }) {
  const [mode, setMode] = useState<BoundaryMode>("shield");
  const [token, setToken] = useState<Token>(tokenBySymbol("ETH"));
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const [exact, setExact] = useState(false);
  const [spread, setSpread] = useState<string | null>(null);
  const [publicBal, setPublicBal] = useState("0");
  const [confirming, setConfirming] = useState(false);

  const refreshBal = useCallback(async () => {
    if (!wallet.address) {
      setPublicBal("0");
      return;
    }
    setPublicBal(await wallet.getBalance(token));
  }, [wallet, token]);

  useEffect(() => {
    refreshBal();
  }, [refreshBal, wallet.address]);

  const value = useMemo(() => {
    try {
      return parseUnits(amount || "0", token.decimals);
    } catch {
      return 0n;
    }
  }, [amount, token.decimals]);

  const { parts, remainder } = useMemo(
    () => decompose(value, token.decimals),
    [value, token.decimals],
  );
  const grouped = groupParts(parts);
  const planLabel = grouped
    .map((g) => `${g.count} × ${fmtUnits(g.tier, token.decimals)}`)
    .join(" · ");
  const smallestTier = tiersFor(token.decimals).slice(-1)[0];

  const amt = parseFloat(amount) || 0;
  const bal = parseFloat(publicBal) || 0;
  const insufficient = mode === "shield" && !!wallet.address && amt > bal;
  const belowTier = !exact && value > 0n && parts.length === 0;
  const tooMany = !exact && parts.length > MAX_BOUNDARY_TXS;
  const ready =
    !!wallet.address && !wallet.wrongNetwork && amt > 0 && !insufficient && !belowTier && !tooMany;

  let label = "Enter an amount";
  if (amt > 0) label = mode === "shield" ? "Review shield" : "Review unshield";
  if (belowTier) label = `Below the ${fmtUnits(smallestTier, token.decimals)} tier · go Exact`;
  if (tooMany) label = "Round the amount, or go Exact";
  if (insufficient) label = `Insufficient ${token.symbol}`;

  const pick = (t: Token) => {
    setToken(t);
    setAmount("");
  };

  const flip = () => {
    setMode((m) => (m === "shield" ? "unshield" : "shield"));
    setAmount("");
  };

  // Listed tokens carry a live USD price off the explorer; the anchors cover the rest.
  const usd = amt * (token.priceUsd ?? USD[token.symbol] ?? 0);
  const relay = wallet.network.defaultRelay;

  const publicSide = (
    <span className="flex items-center gap-2 text-[0.7rem] text-faint font-data whitespace-nowrap">
      <span>
        {bal.toLocaleString("en-US", { maximumFractionDigits: 4 })} {token.symbol}
      </span>
      {mode === "shield" && !!wallet.address && (
        <button onClick={() => setAmount(publicBal)} className="text-acid hover:text-acid2 font-data text-[0.65rem]">
          MAX
        </button>
      )}
    </span>
  );

  return (
    <div className="w-full max-w-[460px] mx-auto">
      {/* Card */}
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            {(["shield", "unshield"] as BoundaryMode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                }}
                className={`label-mono text-[0.72rem] transition-colors ${
                  mode === m ? "text-bone border-b border-acid pb-0.5" : "text-faint hover:text-muted"
                }`}
              >
                {m === "shield" ? "Shield" : "Unshield"}
              </button>
            ))}
          </div>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="The pool's public edge. Shielding in and unshielding out are visible on chain; what happens inside is not."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              Boundary
            </span>
          </span>
        </div>

        {/* Source panel */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              {mode === "unshield" && <MaskLogo className="h-2 w-auto text-acid" />}
              {mode === "shield" ? "Public wallet" : "Shielded balance"}
            </span>
            {mode === "shield" && publicSide}
          </div>
          <div className="flex items-center gap-3">
            <input
              className="amount text-3xl md:text-4xl text-bone placeholder:text-faint outline-none font-data tracking-tight"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                setAmount(v);
              }}
            />
            <button
              onClick={() => setPicking(true)}
              className="shrink-0 flex items-center gap-2 bg-ink3 hover:bg-[#1c2027] pl-2 pr-3 py-2 transition-colors"
            >
              <TokenGlyph symbol={token.symbol} src={token.logoURI} />
              <span className="label-mono text-[0.78rem] text-bone">{token.symbol}</span>
              <span className="text-faint text-xs">▾</span>
            </button>
          </div>
          <div className="mt-2 text-[0.7rem] text-faint font-data">
            ${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
        </div>

        {/* Flip */}
        <div className="relative h-0 flex justify-center">
          <button
            onClick={flip}
            className="absolute -translate-y-1/2 h-9 w-9 flex items-center justify-center bg-ink3 hover:bg-acid hover:text-ink text-bone transition-colors"
            title="Flip"
          >
            ↓
          </button>
        </div>

        {/* Destination panel */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              {mode === "shield" && <MaskLogo className="h-2 w-auto text-acid" />}
              {mode === "shield" ? "Shielded balance" : "Public wallet"}
            </span>
            {mode === "unshield" && publicSide}
          </div>
          <div className="flex items-center gap-3">
            <span className="amount text-3xl md:text-4xl font-data tracking-tight text-acid">
              {amt > 0 ? amount : <span className="text-faint">0</span>}
            </span>
            <span className="shrink-0 label-mono text-[0.78rem] text-muted pr-1">{token.symbol}</span>
          </div>
        </div>

        {/* Privacy options */}
        <div className="mt-3 px-1 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              Denominations
              <InfoTip text="An exact amount is a fingerprint: shield 0.2337, later withdraw 0.2337, and the two ends link. Shared splits it into standard tiers (0.001 to 10) so every crossing looks like every other. Exact moves the raw amount in one transaction." />
            </span>
            <div className="flex gap-1">
              {[false, true].map((ex) => (
                <button
                  key={String(ex)}
                  onClick={() => setExact(ex)}
                  className={`px-2.5 py-1 text-xs font-data transition-colors ${
                    exact === ex ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
                  }`}
                >
                  {ex ? "Exact" : "Shared"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              Spread
              <InfoTip text="Fires the transactions at random moments across the window instead of one burst, so timing doesn't group them. Off submits them back to back." />
            </span>
            <div className="flex gap-1">
              {[null, ...SPREADS].map((s) => (
                <button
                  key={s ?? "off"}
                  onClick={() => setSpread(s)}
                  className={`px-2.5 py-1 text-xs font-data transition-colors ${
                    spread === s ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
                  }`}
                >
                  {s ?? "Off"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Plan details */}
        {amt > 0 && (
          <div className="mt-3 px-1 space-y-2 fade-up">
            {!exact && parts.length > 0 && (
              <Row
                k="Plan"
                v={`${planLabel} · ${parts.length} ${
                  mode === "shield"
                    ? parts.length === 1 ? "deposit" : "deposits"
                    : parts.length === 1 ? "withdrawal" : "withdrawals"
                }`}
              />
            )}
            {!exact && remainder > 0n && (
              <Row
                k="Remainder"
                v={`${fmtUnits(remainder, token.decimals)} stays ${
                  mode === "shield" ? "public" : "shielded"
                } · Exact includes it`}
              />
            )}
            {exact && <Row k="Boundary" v="exact amount · 1 transaction" />}
            {spread && <Row k="Spread" v={`${spread} window · random moments`} />}
            {mode === "shield" ? (
              <Row k="Gas payer" v="You, per deposit" />
            ) : (
              <>
                <Row k="Route" v="Shielded pool → relayer" accent />
                <Row k="Gas payer" v="Relayer (gasless)" accent />
              </>
            )}
          </div>
        )}

        {/* Action */}
        <div className="mt-4">
          {!wallet.address ? (
            <button
              onClick={wallet.connect}
              disabled={wallet.connecting}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
            >
              {wallet.connecting ? "Connecting…" : wallet.hasWallet ? "Connect wallet" : "Get a wallet"}
            </button>
          ) : wallet.wrongNetwork ? (
            <button
              onClick={wallet.switchNetwork}
              className="w-full label-mono text-sm py-4 bg-[#3a1414] text-[#ff6b6b] hover:bg-[#4a1818] transition-colors"
            >
              Switch to {wallet.network.label}
            </button>
          ) : (
            <button
              onClick={() => ready && setConfirming(true)}
              disabled={!ready}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors disabled:bg-ink3 disabled:text-faint"
            >
              {label}
            </button>
          )}
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        {mode === "shield"
          ? "Inside the pool, every note looks like every other."
          : "The relayer submits and pays gas. Your wallet never signs."}
      </p>

      <TokenModal
        open={picking}
        tokens={BOUNDARY_TOKENS}
        allowImport
        owner={wallet.address as `0x${string}` | null}
        onClose={() => setPicking(false)}
        onSelect={pick}
      />

      <BoundaryConfirmModal
        open={confirming}
        mode={mode}
        token={token}
        amount={amount}
        planLabel={!exact && parts.length > 0 ? planLabel : undefined}
        txCount={exact ? 1 : parts.length}
        remainderLabel={
          !exact && remainder > 0n
            ? `${fmtUnits(remainder, token.decimals)} ${token.symbol} stays ${mode === "shield" ? "public" : "shielded"}`
            : undefined
        }
        exact={exact}
        spread={spread ?? undefined}
        relay={relay}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs gap-4">
      <span className="text-faint font-data shrink-0">{k}</span>
      <span className={`font-data text-right ${accent ? "text-acid" : "text-muted"}`}>{v}</span>
    </div>
  );
}
