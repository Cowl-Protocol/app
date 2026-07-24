"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tokenBySymbol, type Token } from "@/lib/tokens";
import { USD } from "@/lib/prices";
import type { useWallet } from "@/lib/useWallet";
import TokenModal, { TokenGlyph } from "./TokenModal";
import ConfirmModal from "./ConfirmModal";

type WalletState = ReturnType<typeof useWallet>;

// Cross-rate between the shared USD anchors = from-USD / to-USD.
function rate(from: string, to: string): number {
  const f = USD[from] ?? 0;
  const t = USD[to] ?? 0;
  return t === 0 ? 0 : f / t;
}

function fmt(n: number, max = 6): string {
  if (!isFinite(n) || n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export default function SwapCard({ wallet }: { wallet: WalletState }) {
  const [pay, setPay] = useState<Token>(tokenBySymbol("ETH"));
  const [receive, setReceive] = useState<Token>(tokenBySymbol("USDG"));
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState<null | "pay" | "receive">(null);
  const [payBal, setPayBal] = useState("0");
  const [confirming, setConfirming] = useState(false);
  const [slippage, setSlippage] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);

  const out = useMemo(() => {
    const a = parseFloat(amount);
    if (!a || a <= 0) return 0;
    return a * rate(pay.symbol, receive.symbol);
  }, [amount, pay.symbol, receive.symbol]);

  const refreshBal = useCallback(async () => {
    if (!wallet.address) {
      setPayBal("0");
      return;
    }
    setPayBal(await wallet.getBalance(pay));
  }, [wallet, pay]);

  useEffect(() => {
    refreshBal();
  }, [refreshBal, wallet.address]);

  const flip = () => {
    setPay(receive);
    setReceive(pay);
    setAmount("");
  };

  const select = (t: Token) => {
    if (picking === "pay") {
      if (t.symbol === receive.symbol) setReceive(pay);
      setPay(t);
    } else {
      if (t.symbol === pay.symbol) setPay(receive);
      setReceive(t);
    }
    setAmount("");
  };

  const amt = parseFloat(amount) || 0;
  const bal = parseFloat(payBal) || 0;
  const insufficient = wallet.address && amt > bal;
  const ready = !!wallet.address && !wallet.wrongNetwork && amt > 0 && !insufficient;

  let label = "Enter an amount";
  if (amt > 0) label = "Review private swap";
  if (insufficient) label = `Insufficient ${pay.symbol}`;

  const minReceived = out * (1 - slippage / 100);

  return (
    <div className="w-full max-w-[460px] mx-auto">
      {/* Card */}
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <span className="label-mono text-[0.72rem] text-bone">Swap</span>
          <div className="flex items-center gap-3 relative">
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              Private
            </span>
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="text-faint hover:text-bone text-sm"
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <div className="absolute right-0 top-8 z-20 bg-ink3 p-4 w-56 fade-up">
                <p className="label-mono text-[0.62rem] text-muted mb-3">Max slippage</p>
                <div className="flex gap-2">
                  {[0.1, 0.5, 1].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={`flex-1 py-1.5 text-xs font-mono transition-colors ${
                        slippage === s ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
                      }`}
                    >
                      {s}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pay panel */}
        <Panel
          title="You pay"
          token={pay}
          amount={amount}
          editable
          onAmount={setAmount}
          usd={amt * (USD[pay.symbol] ?? 0)}
          balance={payBal}
          showMax={!!wallet.address}
          onMax={() => setAmount(payBal)}
          onPick={() => setPicking("pay")}
        />

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

        {/* Receive panel */}
        <Panel
          title="You receive"
          token={receive}
          amount={out === 0 ? "" : fmt(out)}
          usd={out * (USD[receive.symbol] ?? 0)}
          onPick={() => setPicking("receive")}
        />

        {/* Rate + privacy details */}
        {amt > 0 && (
          <div className="mt-3 px-1 space-y-2 fade-up">
            <Row
              k="Rate"
              v={`1 ${pay.symbol} = ${fmt(rate(pay.symbol, receive.symbol), 4)} ${receive.symbol}`}
            />
            <Row k="Min. received" v={`${fmt(minReceived)} ${receive.symbol}`} />
            <Row k="Route" v="Shielded pool → relayer" accent />
            <Row k="Gas payer" v="Relayer (gasless)" accent />
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
        Trades route through the shielded pool. Your wallet never appears as the counterparty.
      </p>

      <TokenModal
        open={picking !== null}
        exclude={picking === "pay" ? receive.symbol : pay.symbol}
        onClose={() => setPicking(null)}
        onSelect={select}
      />

      <ConfirmModal
        open={confirming}
        pay={pay}
        receive={receive}
        amount={amount}
        out={fmt(out)}
        minReceived={fmt(minReceived)}
        relay={wallet.network.defaultRelay}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function Panel({
  title,
  token,
  amount,
  editable,
  onAmount,
  usd,
  balance,
  showMax,
  onMax,
  onPick,
}: {
  title: string;
  token: Token;
  amount: string;
  editable?: boolean;
  onAmount?: (v: string) => void;
  usd: number;
  balance?: string;
  showMax?: boolean;
  onMax?: () => void;
  onPick: () => void;
}) {
  return (
    <div className="bg-ink2 p-4 my-1">
      <div className="flex items-center justify-between mb-2">
        <span className="label-mono text-[0.62rem] text-faint">{title}</span>
        {balance !== undefined && (
          <span className="flex items-center gap-2 text-[0.7rem] text-faint font-mono">
            <span>
              {parseFloat(balance).toLocaleString("en-US", { maximumFractionDigits: 4 })} {token.symbol}
            </span>
            {showMax && (
              <button onClick={onMax} className="text-acid hover:text-acid2 label-mono text-[0.6rem]">
                MAX
              </button>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <input
          className="amount text-3xl md:text-4xl text-bone placeholder:text-faint outline-none font-data tracking-tight"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          readOnly={!editable}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, "");
            onAmount?.(v);
          }}
        />
        <button
          onClick={onPick}
          className="shrink-0 flex items-center gap-2 bg-ink3 hover:bg-[#1c2027] pl-2 pr-3 py-2 transition-colors"
        >
          <TokenGlyph symbol={token.symbol} />
          <span className="label-mono text-[0.78rem] text-bone">{token.symbol}</span>
          <span className="text-faint text-xs">▾</span>
        </button>
      </div>
      <div className="mt-2 text-[0.7rem] text-faint font-mono">
        ${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
      </div>
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-faint font-mono">{k}</span>
      <span className={`font-mono ${accent ? "text-acid" : "text-muted"}`}>{v}</span>
    </div>
  );
}
