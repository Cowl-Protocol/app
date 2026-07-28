"use client";

// The private swap, live.
//
// A trade is exact-output: the amount typed is what arrives, and the venue's
// quoter answers what the router will draw for it. One adapter call carries
// the whole thing — spend to the adapter, swap at the venue, the exact output
// re-shielded — and reverts as a unit, so a trade either happens whole or not
// at all. The pay side is derived, not picked: every route is one hop at the
// venue's fee tier, native against a token, or the dollar back to native.
//
// Gasless is the default here as everywhere: the relayer's fee comes out of
// the notes being spent and it submits, so no wallet of the trader's appears
// anywhere in the swap. Self-paid stays one chip away, with the CLI's 1%
// input headroom, refunded to the wallet that paid for it.
import { useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { TOKENS, tokenBySymbol, tokenMetaForField, type Token } from "@/lib/tokens";
import { formatBalanceShort, formatUnitsExact, usdOf } from "@/lib/prices";
import { useTokenPrice } from "@/lib/tokenPrice";
import { tiersFor } from "@/lib/denominations";
import { useRelayQuote, useSelfGasEstimate } from "@/lib/relay";
import { tradeInputFor, useTradeQuote } from "@/lib/trade";
import { activeNetwork } from "@/lib/networks";
import { useAssets, useShieldedAssets } from "@/lib/assets";
import type { useWallet } from "@/lib/useWallet";
import { useShielded } from "./ShieldedProvider";
import SwapConfirmModal from "./SwapConfirmModal";
import { MergeProgressModal } from "./SendCard";
import TokenModal, { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";
import Spinner from "./Spinner";

type WalletState = ReturnType<typeof useWallet>;

const net = activeNetwork();

/** Receive-side choices: the curated list less WETH (the venue leg native
 * already trades through) and anything with no address to quote. Imports are
 * open — a pasted RWA is selectable, and the quoter decides if it routes. */
const SWAP_TOKENS = TOKENS.filter(
  (t) => t.symbol !== "WETH" && (t.native || !/^0x0{40}$/i.test(t.address)),
);

function logoFor(field: bigint): string | undefined {
  if (field === 0n) return TOKENS.find((t) => t.native)?.logoURI;
  return TOKENS.find((t) => !t.native && !/^0x0{40}$/i.test(t.address) && BigInt(t.address) === field)?.logoURI;
}

/** Display form of a pay-side amount: enough digits for an ETH quote, trimmed. */
function fmtIn(v: bigint, decimals: number): string {
  const [i, f = ""] = formatUnits(v, decimals).split(".");
  const ff = f.slice(0, 8).replace(/0+$/, "");
  return ff ? `${i}.${ff}` : i;
}

export default function SwapCard({ wallet }: { wallet: WalletState }) {
  const shielded = useShielded();
  const [receive, setReceive] = useState<Token>(tokenBySymbol("USDG"));
  const [amount, setAmount] = useState("");
  const [exact, setExact] = useState(false);
  const [selfPay, setSelfPay] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState<null | "pay" | "receive">(null);
  const [merging, setMerging] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const unlocked = shielded.status === "ready";

  const outField = receive.native ? 0n : BigInt(receive.address);
  const inField = tradeInputFor(outField);
  const inMeta = tokenMetaForField(inField);

  const amountOut = useMemo(() => {
    try {
      return parseUnits(amount || "0", receive.decimals);
    } catch {
      return 0n;
    }
  }, [amount, receive.decimals]);

  // Uniform trade sizes, same reasoning as the pool boundary: a trade for an
  // oddly specific amount is a fingerprint on public liquidity. Exact opts out.
  const tiers = useMemo(() => tiersFor(receive.decimals), [receive.decimals]);
  const onTier = tiers.includes(amountOut);
  const sizeOk = exact || onTier;
  const tierBelow = tiers.filter((t) => t < amountOut).at(0);
  const tierAbove = [...tiers].reverse().filter((t) => t > amountOut).at(0);

  // The venue's price for this exact output, kept fresh while the card is open.
  const tradeQuote = useTradeQuote(inField, outField, amountOut);
  const priced = tradeQuote.state === "priced";
  const quotedIn = priced ? tradeQuote.quotedIn : 0n;

  // Who pays the gas, asked before anything is signed. A trade's fee is sized
  // from its own gas figure, which is why the quote names the op.
  const { quote: relay, checking: relayChecking } = useRelayQuote(inField, amountOut > 0n, "trade");
  const gasless = !!relay && !selfPay;

  // Self-submitted trades carry 1% of headroom over the quote — the venue
  // moves during the proving window, and the adapter refunds what the router
  // does not draw to the submitter, which self-paid is the trader's own
  // wallet. Relayed trades keep the bare quote: that refund would tip the
  // relayer instead. The run re-quotes before proving; this is the display.
  const maxIn = quotedIn + (gasless ? 0n : quotedIn / 100n);
  const relayFee = gasless && relay ? relay.fee : 0n;
  const drawn = maxIn + relayFee;
  const selfGas = useSelfGasEstimate(1, amountOut > 0n && !gasless, net.tradeGas ?? 15_000_000n);

  const balance = unlocked ? shielded.balanceOf(inField) : 0n;
  const sendable = unlocked ? shielded.sendableOf(inField) : 0n;
  // What the book already holds of the receive side — after a swap lands, this
  // is the line that visibly ticks up with the fresh note.
  const receiveBal = unlocked ? shielded.balanceOf(outField) : 0n;

  // The public book, borrowed only to name and price what the shielded one
  // holds — the same modal rows the send card shows. The pay picker offers the
  // shielded book filtered to what can actually fund a route: native or USDG.
  const { assets: publicAssets } = useAssets(wallet.address as `0x${string}` | null);
  const { assets: shieldedAssets, loading: shieldedLoading } = useShieldedAssets(
    unlocked ? shielded.balances : [],
    publicAssets,
  );
  const usdgField = net.contracts.usdg ? BigInt(net.contracts.usdg) : 0n;
  const payAssets = shieldedAssets.filter(
    (a) => a.token.native || (!/^0x0{40}$/i.test(a.token.address) && BigInt(a.token.address) === usdgField),
  );

  const overBalance = priced && unlocked && drawn > balance;
  // A join-split reads two notes at most; merging lifts the ceiling.
  const overSendable = priced && unlocked && !overBalance && drawn > sendable;
  // Blocked by the fee, not by the trade — the switch exists for exactly this.
  const feeTrapped = !!relay && !selfPay && priced && unlocked && maxIn <= balance && overBalance;

  const price = useTokenPrice(receive);
  const usd = usdOf(parseFloat(amount) || 0, price);

  // The venue's price per whole token, for the rate row.
  const rate =
    priced && amountOut > 0n
      ? fmtIn((quotedIn * 10n ** BigInt(receive.decimals)) / amountOut, inMeta.decimals)
      : null;

  const ready =
    unlocked &&
    !!wallet.address &&
    !wallet.wrongNetwork &&
    amountOut > 0n &&
    sizeOk &&
    priced &&
    !overBalance &&
    !overSendable;

  let label = "Enter an amount";
  if (amountOut > 0n) label = "Review private swap";
  if (amountOut > 0n && !sizeOk) label = "Pick a shared size";
  if (amountOut > 0n && sizeOk && tradeQuote.state === "checking") label = "Pricing at the venue";
  if (tradeQuote.state === "unpriceable") label = `No venue route for ${receive.symbol}`;
  if (unlocked && balance === 0n) label = `Shield ${inMeta.symbol} first`;
  if (overBalance) {
    label = feeTrapped
      ? "Not enough for the trade plus the relayer fee"
      : `Insufficient shielded ${inMeta.symbol}`;
  }
  if (overSendable) label = `Merge notes to swap this much`;

  const flip = () => {
    setReceive(receive.native ? tokenBySymbol("USDG") : tokenBySymbol("ETH"));
    setAmount("");
  };

  const unlock = async () => {
    setUnlockError(null);
    try {
      await shielded.unlock();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUnlockError(/rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0] ?? msg);
    }
  };

  const merge = () => {
    shielded.clearProgress();
    setMerging(true);
    shielded
      // The input cap, not the full draw: the run quotes its own fee per round.
      .consolidateExec({
        tokenField: inField,
        symbol: inMeta.symbol,
        decimals: inMeta.decimals,
        target: maxIn,
        selfPay,
      })
      .catch(() => {});
  };

  const execute = () => {
    shielded.clearProgress();
    shielded
      .tradeExec({
        amountOut,
        tokenOutField: outField,
        outSymbol: receive.symbol,
        outDecimals: receive.decimals,
        tokenInField: inField,
        selfPay,
      })
      .catch(() => {});
  };

  const closeConfirm = () => {
    setConfirming(false);
    if (shielded.progress?.done) {
      setAmount("");
      // The choice was for that trade. The next one starts gasless again.
      setSelfPay(false);
    }
    shielded.clearProgress();
  };

  const setTier = (t: bigint) => setAmount(formatUnits(t, receive.decimals));

  /**
   * Picking the pay side steers the route rather than fighting it: native
   * funds a token purchase, so the receive side gets the dollar if it was
   * native; the dollar only ever buys native back.
   */
  const pickPay = (t: Token) => {
    const f = t.native ? 0n : BigInt(t.address);
    if (f === 0n) {
      if (receive.native) setReceive(tokenBySymbol("USDG"));
    } else {
      setReceive(tokenBySymbol("ETH"));
    }
    setAmount("");
    setExact(false);
    setSelfPay(false);
    setPicking(null);
  };

  const pickReceive = (t: Token) => {
    setReceive(t);
    setAmount("");
    setExact(false);
    // A different pair is a different fee question — back to the default.
    setSelfPay(false);
    setPicking(null);
  };

  return (
    <div className="w-full max-w-[460px] mx-auto">
      {/* Card */}
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <span className="label-mono text-[0.72rem] text-bone">Swap</span>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="The trade spends shielded notes and its output re-shields in the same transaction. The venue sees a swap from the pool — relayed, your wallet appears nowhere in it."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">Private</span>
          </span>
        </div>

        {/* Pay panel — derived, the venue's price for the exact output below */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              <MaskLogo className="h-2 w-auto text-acid" />
              You pay
            </span>
            {unlocked && (
              <span className="flex items-center gap-2 text-[0.7rem] text-faint font-data whitespace-nowrap">
                <span title={`${formatUnitsExact(balance, inMeta.decimals)} ${inMeta.symbol} shielded`}>
                  {formatBalanceShort(balance, inMeta.decimals)} {inMeta.symbol} shielded
                </span>
                {shielded.syncing && <Spinner className="h-3 w-3 text-acid" />}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              className="amount text-3xl md:text-4xl text-bone placeholder:text-faint outline-none font-data tracking-tight"
              placeholder="0"
              value={priced ? fmtIn(quotedIn, inMeta.decimals) : ""}
              readOnly
            />
            <button
              onClick={() => setPicking("pay")}
              className="shrink-0 flex items-center gap-2 bg-ink3 pl-2 pr-3 py-2 transition-colors hover:bg-[#1c2027]"
            >
              <TokenGlyph symbol={inMeta.symbol} src={logoFor(inField)} />
              <span className="label-mono text-[0.78rem] text-bone">{inMeta.symbol}</span>
              <span className="text-faint text-xs">▾</span>
            </button>
          </div>
          {priced && !gasless && maxIn > quotedIn && (
            <div className="mt-2 text-[0.7rem] text-faint font-data">
              max {fmtIn(maxIn, inMeta.decimals)} — unused headroom refunds to your wallet
            </div>
          )}
        </div>

        {/* Flip */}
        <div className="relative h-0 flex justify-center">
          <button
            onClick={flip}
            className="absolute -translate-y-1/2 h-9 w-9 flex items-center justify-center bg-ink3 text-bone transition-colors hover:bg-acid hover:text-ink"
            title="Flip"
          >
            ↓
          </button>
        </div>

        {/* Receive panel — the exact side, where the amount is typed */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="label-soft text-faint whitespace-nowrap">You receive · exact</span>
            {unlocked && (
              <span
                className="text-[0.7rem] text-faint font-data whitespace-nowrap"
                title={`${formatUnitsExact(receiveBal, receive.decimals)} ${receive.symbol} shielded`}
              >
                {formatBalanceShort(receiveBal, receive.decimals)} {receive.symbol} shielded
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              className="amount text-3xl md:text-4xl text-bone placeholder:text-faint outline-none font-data tracking-tight"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <button
              onClick={() => setPicking("receive")}
              className="shrink-0 flex items-center gap-2 bg-ink3 pl-2 pr-3 py-2 transition-colors hover:bg-[#1c2027]"
            >
              <TokenGlyph symbol={receive.symbol} src={receive.logoURI} />
              <span className="label-mono text-[0.78rem] text-bone">{receive.symbol}</span>
              <span className="text-faint text-xs">▾</span>
            </button>
          </div>
          {usd && <div className="mt-2 text-[0.7rem] text-faint font-data">{usd}</div>}
          {/* Shared sizes, stated before someone trips on them. The nudge is a
              way forward in both directions: the nearest tiers, or exact. */}
          {amountOut > 0n && !onTier && (
            <div
              className={`mt-3 px-3 py-2 text-[0.7rem] leading-relaxed transition-colors ${
                exact ? "bg-ink3 text-faint" : "bg-warn/10 text-warn"
              }`}
            >
              {exact ? (
                <>
                  Trading exactly {amount} {receive.symbol}. An exact amount settles in one go but
                  reads as one of a kind on public liquidity.{" "}
                  <button
                    onClick={() => setExact(false)}
                    className="text-acid hover:text-acid2 transition-colors"
                  >
                    Back to shared sizes
                  </button>
                </>
              ) : (
                <>
                  Trades travel in shared sizes, so every 0.1 looks like every other 0.1. Nearest:{" "}
                  {[tierAbove, tierBelow]
                    .filter((t): t is bigint => t !== undefined)
                    .map((t, i) => (
                      <button
                        key={i}
                        onClick={() => setTier(t)}
                        className="text-acid hover:text-acid2 transition-colors font-data"
                      >
                        {i > 0 && " · "}
                        {formatUnits(t, receive.decimals)}
                      </button>
                    ))}{" "}
                  — or{" "}
                  <button
                    onClick={() => setExact(true)}
                    className="text-acid hover:text-acid2 transition-colors"
                  >
                    trade exactly {amount}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {overSendable && (
          <p className="text-[0.7rem] text-faint leading-relaxed mt-3">
            One spend reads two notes, and your two largest come to{" "}
            {formatUnitsExact(sendable, inMeta.decimals)} {inMeta.symbol}. Merging combines them
            into bigger notes, back to yourself, until this trade fits in two.
          </p>
        )}

        {/* What this costs, and what it shows */}
        {amountOut > 0n && sizeOk && (
          <div className="mt-3 px-1 space-y-2 fade-up">
            {tradeQuote.state === "unpriceable" ? (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                The venue has no pool pricing {receive.symbol} against{" "}
                {inField === 0n ? "WETH" : inMeta.symbol} at the trade&apos;s fee tier, so this pair
                cannot route yet.
              </p>
            ) : (
              <>
                {rate && <Row k="Rate" v={`1 ${receive.symbol} = ${rate} ${inMeta.symbol}`} />}
                <Row k="Output" v="exact — proven before submitting" accent />
                <Row k="Proving" v="In your browser" accent />
                <Row
                  k="Wallet confirmations"
                  v={relayChecking ? "…" : gasless ? "0" : "1"}
                  accent={gasless}
                />
                {/* The same pair the CLI spells with --self. Relayed keeps this
                    wallet out of the trade entirely; self-paid zeroes the fee
                    and gains refundable headroom. */}
                <div className="flex items-center justify-between text-xs gap-4">
                  <span className="flex items-center gap-1.5 text-faint font-data shrink-0">
                    Gas payer
                    {relay && !relayChecking && (
                      <InfoTip text="The relayer submits the trade, so your wallet never appears in it, and its fee comes out of the notes being spent. Pay the gas yourself and no fee leaves the notes — your wallet submits, shows as the caller, and keeps the headroom refund." />
                    )}
                  </span>
                  {relayChecking ? (
                    <span className="font-data text-muted text-right">…</span>
                  ) : relay ? (
                    <div className="flex gap-1">
                      {[false, true].map((self) => (
                        <button
                          key={String(self)}
                          onClick={() => setSelfPay(self)}
                          className={`px-2.5 py-1 text-xs font-data transition-colors ${
                            selfPay === self ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
                          }`}
                        >
                          {self ? "You" : "The relayer"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="font-data text-muted text-right">You</span>
                  )}
                </div>
                {!gasless && (
                  <Row
                    k="Network fee"
                    v={
                      selfGas === null
                        ? "estimating"
                        : `~${formatBalanceShort(selfGas, 18)} ${net.currency.symbol}`
                    }
                  />
                )}
                {gasless && priced && (
                  <>
                    <Row
                      k="Relayer fee"
                      v={`${formatBalanceShort(relayFee, inMeta.decimals)} ${inMeta.symbol}`}
                    />
                    <Row
                      k="Drawn from your balance"
                      v={`${fmtIn(drawn, inMeta.decimals)} ${inMeta.symbol}`}
                      accent
                    />
                  </>
                )}
                {!gasless && !relayChecking && priced && (
                  <p className="text-[0.7rem] text-faint leading-relaxed pt-1">
                    Your wallet submits this trade and pays its gas, so it shows on chain as the
                    caller. The notes that fund it stay sealed either way.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* The way past the fee, on the screen that named it. */}
        {feeTrapped && (
          <div className="mt-3 px-3 py-2 bg-ink3 fade-up">
            <p className="text-[0.7rem] text-faint leading-relaxed">
              It is the relayer&apos;s fee this balance cannot cover — the trade itself fits. Pay
              the gas from your wallet and nothing is drawn from the notes but the trade.
            </p>
            <button
              onClick={() => setSelfPay(true)}
              className="mt-1.5 label-mono text-[0.68rem] text-acid hover:text-acid2 transition-colors"
            >
              Pay gas yourself →
            </button>
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
              {wallet.connecting ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner className="h-3 w-3" />
                  Connecting
                </span>
              ) : wallet.hasWallet ? (
                "Connect wallet"
              ) : (
                "Get a wallet"
              )}
            </button>
          ) : wallet.wrongNetwork ? (
            <button
              onClick={wallet.switchNetwork}
              className="w-full label-mono text-sm py-4 bg-[#3a1414] text-[#ff6b6b] hover:bg-[#4a1818] transition-colors"
            >
              Switch to {wallet.network.label}
            </button>
          ) : !unlocked ? (
            <button
              onClick={unlock}
              disabled={shielded.status === "unlocking"}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
            >
              {shielded.status === "unlocking" ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner className="h-3 w-3" />
                  Check your wallet
                </span>
              ) : (
                "Unlock shielded account"
              )}
            </button>
          ) : overSendable ? (
            <button
              onClick={merge}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              {label}
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
          {unlockError && <p className="text-xs text-[#ff6b6b] mt-2 text-center">{unlockError}</p>}
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        {unlocked
          ? "Trades settle from your shielded balance. Relayed, your wallet never appears as the counterparty."
          : "One wallet signature derives your shielded keys — trades settle from your shielded balance."}
      </p>

      {/* The pay picker offers the shielded book, the way the send card does —
          a token with no note behind it cannot fund a trade. Before unlock it
          falls back to the two tokens a route can start from. */}
      {unlocked ? (
        <TokenModal
          open={picking === "pay"}
          assets={payAssets}
          assetsLoading={shieldedLoading}
          emptyNote="Nothing shielded to pay with yet. Shield ETH or USDG and it appears here."
          onClose={() => setPicking(null)}
          onSelect={pickPay}
        />
      ) : (
        <TokenModal
          open={picking === "pay"}
          tokens={SWAP_TOKENS}
          owner={wallet.address as `0x${string}` | null}
          onClose={() => setPicking(null)}
          onSelect={pickPay}
        />
      )}

      {/* The receive picker chooses what arrives — curated list, search, and a
          pasted ERC-20 imports the way it does everywhere else. */}
      <TokenModal
        open={picking === "receive"}
        tokens={SWAP_TOKENS}
        allowImport
        owner={wallet.address as `0x${string}` | null}
        onClose={() => setPicking(null)}
        onSelect={pickReceive}
      />

      <SwapConfirmModal
        open={confirming}
        paySymbol={inMeta.symbol}
        payLogoURI={logoFor(inField)}
        receiveSymbol={receive.symbol}
        receiveLogoURI={receive.logoURI}
        amountOut={amount}
        quotedIn={fmtIn(quotedIn, inMeta.decimals)}
        maxIn={!gasless && maxIn > quotedIn ? fmtIn(maxIn, inMeta.decimals) : undefined}
        usd={usd}
        gasless={gasless}
        relayFee={gasless ? `${formatBalanceShort(relayFee, inMeta.decimals)} ${inMeta.symbol}` : undefined}
        drawn={`${fmtIn(drawn, inMeta.decimals)} ${inMeta.symbol}`}
        networkFee={
          !gasless && selfGas !== null
            ? `~${formatBalanceShort(selfGas, 18)} ${net.currency.symbol}`
            : undefined
        }
        progress={shielded.progress}
        onExecute={execute}
        onClose={closeConfirm}
      />

      {/* Merging is a run of real transactions, one per round. */}
      {merging && (
        <MergeProgressModal
          symbol={inMeta.symbol}
          progress={shielded.progress}
          onClose={() => {
            setMerging(false);
            shielded.clearProgress();
          }}
        />
      )}
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
