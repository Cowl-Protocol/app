"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type Token } from "@/lib/tokens";
import { decompose, groupParts, MAX_BOUNDARY_TXS, tiersFor } from "@/lib/denominations";
import { USD } from "@/lib/prices";
import type { useWallet } from "@/lib/useWallet";
import BoundaryConfirmModal, { type BoundaryMode } from "./BoundaryConfirmModal";
import { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";

type WalletState = ReturnType<typeof useWallet>;

// The boundary moves the pool's real pair: the native coin and USDG. Everything
// else stays private-side, where amounts never surface and need no tiers.
const BOUNDARY_SYMBOLS = ["ETH", "USDG"] as const;

const SPREADS = ["45s", "20m", "3h"] as const;

function fmtUnits(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export default function ShieldCard({ wallet }: { wallet: WalletState }) {
  const [mode, setMode] = useState<BoundaryMode>("shield");
  const [token, setToken] = useState<Token>(tokenBySymbol("ETH"));
  const [amount, setAmount] = useState("");
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
  if (belowTier) label = `Below the ${fmtUnits(smallestTier, token.decimals)} tier — go Exact`;
  if (tooMany) label = "Round the amount, or go Exact";
  if (insufficient) label = `Insufficient ${token.symbol}`;

  const pick = (sym: string) => {
    if (sym === token.symbol) return;
    setToken(tokenBySymbol(sym));
    setAmount("");
  };

  const flip = () => {
    setMode((m) => (m === "shield" ? "unshield" : "shield"));
    setAmount("");
  };

  const usd = amt * (USD[token.symbol] ?? 0);
  const relay = wallet.network.defaultRelay;

  const publicSide = (
    <span className="flex items-center gap-2 text-[0.7rem] text-faint font-mono">
      <span>
        {bal.toLocaleString("en-US", { maximumFractionDigits: 4 })} {token.symbol}
      </span>
      {mode === "shield" && !!wallet.address && (
        <button onClick={() => setAmount(publicBal)} className="text-acid hover:text-acid2 label-mono text-[0.6rem]">
          MAX
        </button>
      )}
    </span>
  );

  const shieldedSide = (
    <span className="flex items-center gap-1.5 text-[0.7rem] text-faint font-mono">
      <MaskLogo className="h-2 w-auto text-acid" />
      <span>notes stay local · cowl balance</span>
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
          <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
            Boundary
          </span>
        </div>

        {/* Source panel */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between mb-2">
            <span className="label-mono text-[0.62rem] text-faint">
              {mode === "shield" ? "From · Public wallet" : "From · Shielded balance"}
            </span>
            {mode === "shield" ? publicSide : shieldedSide}
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
            <div className="shrink-0 flex items-center gap-1">
              {BOUNDARY_SYMBOLS.map((sym) => (
                <button
                  key={sym}
                  onClick={() => pick(sym)}
                  className={`flex items-center gap-2 pl-2 pr-3 py-2 transition-colors ${
                    token.symbol === sym ? "bg-ink3 text-bone" : "text-faint hover:text-bone"
                  }`}
                >
                  <TokenGlyph symbol={sym} />
                  <span className="label-mono text-[0.78rem]">{sym}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 text-[0.7rem] text-faint font-mono">
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
          <div className="flex items-center justify-between mb-2">
            <span className="label-mono text-[0.62rem] text-faint">
              {mode === "shield" ? "To · Shielded balance" : "To · Public wallet"}
            </span>
            {mode === "shield" ? shieldedSide : publicSide}
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
          <div className="flex items-center justify-between">
            <span className="label-mono text-[0.62rem] text-faint">Denominations</span>
            <div className="flex gap-1">
              {[false, true].map((ex) => (
                <button
                  key={String(ex)}
                  onClick={() => setExact(ex)}
                  className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                    exact === ex ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
                  }`}
                >
                  {ex ? "Exact" : "Shared"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="label-mono text-[0.62rem] text-faint">Spread</span>
            <div className="flex gap-1">
              {[null, ...SPREADS].map((s) => (
                <button
                  key={s ?? "off"}
                  onClick={() => setSpread(s)}
                  className={`px-2.5 py-1 text-xs font-mono transition-colors ${
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
                } — Exact includes it`}
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
      <p className="text-center text-xs text-faint mt-4 font-mono">
        {mode === "shield"
          ? "Deposits cross in shared denominations. Inside, every note looks like every other."
          : "Withdrawals arrive via the relayer. Your wallet never appears as the sender."}
      </p>

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
      <span className="text-faint font-mono shrink-0">{k}</span>
      <span className={`font-mono text-right ${accent ? "text-acid" : "text-muted"}`}>{v}</span>
    </div>
  );
}
