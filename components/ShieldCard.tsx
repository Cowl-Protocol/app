"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type Token } from "@/lib/tokens";
import { activeNetwork } from "@/lib/networks";
import { decompose, groupParts, maxAfterFee, MAX_BOUNDARY_TXS, sharedCeiling, tiersFor } from "@/lib/denominations";
import { formatBalance, formatBalanceShort, formatUnitsExact, usdOf } from "@/lib/prices";
import { useAssets, useShieldedAssets } from "@/lib/assets";
import { useRelayQuote, useSelfGasEstimate } from "@/lib/relay";
import { explainError } from "@/lib/errors";
import { useTokenPrice } from "@/lib/tokenPrice";
import { BETA_USD_CAP, overBetaCap } from "@/lib/betaLimits";
import { parseWindow } from "@/lib/spread";
import { shortAddr, type useWallet } from "@/lib/useWallet";
import BoundaryConfirmModal, { type BoundaryMode } from "./BoundaryConfirmModal";
import { useShielded } from "./ShieldedProvider";
import TokenModal, { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";
import Spinner from "./Spinner";

type WalletState = ReturnType<typeof useWallet>;

// Curated boundary list — the pool takes any ERC-20, so the modal also imports
// a pasted contract address (tokenized stocks and the rest of Robinhood's RWAs).
const BOUNDARY_TOKENS = [tokenBySymbol("ETH"), tokenBySymbol("WETH"), tokenBySymbol("USDG")];

const SPREADS = ["45s", "20m", "3h"] as const;

/**
 * Type size for an amount, chosen by how long it is.
 *
 * MAX is exact to the last base unit, so it can run to twenty-odd characters.
 * At a fixed display size that number ran under the token picker and out past
 * the card's edge; shrinking it keeps the whole figure readable, which matters
 * more here than a constant headline size.
 */
function amountSize(text: string): string {
  const n = text.length;
  if (n <= 9) return "text-3xl md:text-4xl";
  if (n <= 13) return "text-2xl md:text-3xl";
  if (n <= 18) return "text-xl md:text-2xl";
  return "text-lg md:text-xl";
}

function fmtUnits(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export default function ShieldCard({ wallet }: { wallet: WalletState }) {
  const net = activeNetwork();
  const shielded = useShielded();
  const [mode, setMode] = useState<BoundaryMode>("shield");
  const [token, setToken] = useState<Token>(tokenBySymbol("ETH"));
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const [exact, setExact] = useState(false);
  const [spread, setSpread] = useState<string | null>(null);
  // null = the read failed, which is not the same as zero.
  const [publicBal, setPublicBal] = useState<string | null>("0");
  const [confirming, setConfirming] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const tokenField = token.native ? 0n : BigInt(token.address);

  const { address: walletAddress, getBalance } = wallet;
  const refreshBal = useCallback(async () => {
    if (!walletAddress) {
      setPublicBal("0");
      return;
    }
    setPublicBal(await getBalance(token));
  }, [walletAddress, getBalance, token]);

  useEffect(() => {
    refreshBal();
  }, [refreshBal]);

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

  const execParts = exact ? (value > 0n ? [value] : []) : parts;
  const requiredTotal = execParts.reduce((s, p) => s + p, 0n);

  const shieldedBal = shielded.balanceOf(tokenField);
  const unlocked = shielded.status === "ready";

  // What the shielded book actually holds, named and priced like any other
  // asset. This is the only thing an unshield can draw from.
  const { assets: publicAssets } = useAssets(wallet.address as `0x${string}` | null);
  const { assets: shieldedAssets, loading: shieldedLoading } = useShieldedAssets(
    unlocked ? shielded.balances : [],
    publicAssets,
  );

  // Asked before anything signs, so the rows below can name the gas payer and
  // the confirmation count truthfully rather than promising gasless and then
  // opening a wallet.
  const { quote: relay, checking: relayChecking } = useRelayQuote(tokenField, mode === "unshield");
  /**
   * The relayer is the default, not the only door. Self-paid submits each
   * withdrawal from the wallet — the CLI's --self — and zeroes the fee the
   * notes must cover, which is what lets a balance smaller than one fee come
   * back out at all. Withdrawals are never capped; this keeps that true.
   */
  const [selfPay, setSelfPay] = useState(false);
  const gasless = mode === "unshield" && !!relay && !selfPay;
  // The other half of the same question: what it costs when the wallet pays.
  const selfGas = useSelfGasEstimate(execParts.length, !gasless && value > 0n);

  // The relayer's fee is paid out of the same notes, once per part, so it is
  // part of what the book has to cover. Leaving it out let an amount pass every
  // check on screen and then fail at planning, with the notes short by exactly
  // the fee nobody had counted.
  const relayFeeTotal = gasless && relay ? relay.fee * BigInt(execParts.length) : 0n;
  const drawnFromNotes = requiredTotal + relayFeeTotal;

  /**
   * The relayer's fee as a share of what is being withdrawn.
   *
   * The fee is a fixed cost — one spend's gas — so its share falls as the
   * amount grows: the same 0.61 dollars is half of a small withdrawal and a
   * rounding error on a large one. Naming the share is the only way someone
   * sees that, since in token terms a cheap token makes an ordinary fee look
   * enormous.
   */
  const feeSharePct =
    relayFeeTotal > 0n && requiredTotal > 0n
      ? Number((relayFeeTotal * 1000n) / requiredTotal) / 10
      : 0;
  const feeIsSteep = feeSharePct >= 10;

  // Priced off the venue's own pools, whatever the token is — including one
  // pasted in a minute ago. No price, no USD line.
  const price = useTokenPrice(token);

  const amt = parseFloat(amount) || 0;
  const usd = usdOf(amt, price);
  const balUnknown = publicBal === null;
  const bal = parseFloat(publicBal ?? "0") || 0;
  const insufficient =
    mode === "shield"
      ? !!wallet.address && !balUnknown && amt > bal
      : unlocked && drawnFromNotes > shieldedBal;
  const belowTier = !exact && value > 0n && parts.length === 0;
  const tooMany = !exact && parts.length > MAX_BOUNDARY_TXS;
  const needsUnlockFirst = mode === "unshield" && !unlocked;
  // Deposits only. The way out is never capped, whatever the size.
  const overCap = mode === "shield" && overBetaCap(amt, price);
  const ready =
    !!wallet.address &&
    !wallet.wrongNetwork &&
    amt > 0 &&
    !insufficient &&
    !belowTier &&
    !tooMany &&
    !overCap &&
    !needsUnlockFirst;

  let label = "Enter an amount";
  if (amt > 0) label = mode === "shield" ? "Review shield" : "Review unshield";
  if (belowTier) label = `Below the ${fmtUnits(smallestTier, token.decimals)} tier · go Exact`;
  if (tooMany) {
    // Above the ceiling nothing rounds into range, so name the ceiling instead
    // of asking for a rounder number that does not exist.
    const cap = sharedCeiling(token.decimals);
    label =
      value > cap
        ? `Shared tops out at ${fmtUnits(cap, token.decimals)} ${token.symbol} · go Exact`
        : "Round the amount, or go Exact";
  }
  // Sits above the balance check on purpose: when someone is over the cap and
  // short of the balance at the same time, the balance is the one they can act
  // on, so it takes the button.
  if (overCap) label = `Beta caps a deposit at $${BETA_USD_CAP}`;
  if (insufficient) {
    label =
      gasless && relayFeeTotal > 0n && requiredTotal <= shieldedBal
        ? `Not enough for the amount plus the relayer fee`
        : `Insufficient ${mode === "shield" ? "" : "shielded "}${token.symbol}`;
  }
  if (needsUnlockFirst) label = "Unlock to see what you can withdraw";

  // Blocked by the fee, not by the withdrawal: the amount fits the notes and
  // only the relayer's cut on top does not. Paying gas from the wallet zeroes
  // that cut, so the screen that says no also offers the switch.
  const feeTrapped =
    mode === "unshield" &&
    !!relay &&
    !selfPay &&
    unlocked &&
    requiredTotal > 0n &&
    requiredTotal <= shieldedBal &&
    drawnFromNotes > shieldedBal;

  const pick = (t: Token) => {
    setToken(t);
    setAmount("");
    // A different token is a different fee question — back to the default.
    setSelfPay(false);
  };

  const flip = () => {
    setMode((m) => {
      const next = m === "shield" ? "unshield" : "shield";
      // Landing on a token the book holds nothing of reads as an empty balance
      // rather than the wrong pick, so unshield opens on what is actually there.
      if (next === "unshield" && shieldedAssets.length > 0) {
        const held = shieldedAssets.find(
          (a) => a.token.address.toLowerCase() === token.address.toLowerCase(),
        );
        if (!held || (held.balance ?? 0n) === 0n) {
          const biggest = [...shieldedAssets].sort((a, b) => {
            const av = a.balance ?? 0n;
            const bv = b.balance ?? 0n;
            return bv === av ? 0 : bv > av ? 1 : -1;
          })[0];
          if (biggest) setToken(biggest.token);
        }
      }
      return next;
    });
    setAmount("");
    setSelfPay(false);
  };

  const unlock = async () => {
    setUnlockError(null);
    try {
      await shielded.unlock();
    } catch (e) {
      setUnlockError(explainError(e).what);
    }
  };

  const execute = () => {
    // Trying again after a failure finishes the run; it does not start it over.
    // The parts already on chain are carried across so they are skipped, since
    // repeating one would move the same money a second time.
    const prev = shielded.progress;
    const samePlan =
      !!prev?.error &&
      prev.parts.length === execParts.length &&
      prev.parts.every((p, i) => p === execParts[i]);
    const alreadyLanded = samePlan ? prev.txs : [];
    shielded.clearProgress();
    const args = {
      parts: execParts,
      tokenField,
      symbol: token.symbol,
      decimals: token.decimals,
      spreadMs: parseWindow(spread),
      done: alreadyLanded,
    };
    const run =
      mode === "shield"
        ? shielded.shieldExec({ ...args, tokenAddress: token.native ? null : token.address })
        : shielded.unshieldExec({ ...args, selfPay });
    run.then(() => refreshBal()).catch(() => {});
  };

  const closeConfirm = () => {
    setConfirming(false);
    if (shielded.progress?.done) {
      setAmount("");
      refreshBal();
    }
    shielded.clearProgress();
  };

  const shieldedSide = (
    <span className="flex items-center gap-2 text-[0.7rem] text-faint font-data whitespace-nowrap">
      {unlocked ? (
        <>
          <span title={`${formatUnitsExact(shieldedBal, token.decimals)} ${token.symbol}`}>
            {formatBalanceShort(shieldedBal, token.decimals)} {token.symbol}
          </span>
          {mode === "unshield" && shieldedBal > 0n && (
            <button
              // MAX has to leave the relayer's fee behind, or it fills the field
              // with an amount the book can never cover. Self-paid pays no fee
              // from the notes, so its MAX is the whole balance.
              onClick={() =>
                setAmount(
                  formatUnits(
                    maxAfterFee(shieldedBal, gasless && relay ? relay.fee : 0n, token.decimals, exact),
                    token.decimals,
                  ),
                )
              }
              className="text-acid hover:text-acid2 font-data text-[0.65rem]"
            >
              MAX
            </button>
          )}
          {shielded.syncing && <Spinner className="h-3 w-3 text-acid" />}
        </>
      ) : mode === "unshield" ? (
        // Unshield's main button already offers the unlock. Two ways to do the
        // same thing, one of them a dead disabled label, is how the screen came
        // to look like it was refusing the very step it was asking for.
        <span className="text-faint">hidden until unlocked</span>
      ) : (
        <button
          onClick={unlock}
          disabled={shielded.status === "unlocking" || !wallet.address}
          className="text-muted hover:text-bone font-data disabled:text-faint"
        >
          {shielded.status === "unlocking" ? (
            <span className="flex items-center gap-1.5">
              <Spinner className="h-3 w-3" />
              check your wallet
            </span>
          ) : (
            "unlock to view"
          )}
        </button>
      )}
    </span>
  );

  const publicSide = (
    <span className="flex items-center gap-2 text-[0.7rem] text-faint font-data whitespace-nowrap">
      {balUnknown ? (
        <button onClick={refreshBal} className="text-muted hover:text-bone font-data">
          balance unavailable · retry
        </button>
      ) : (
        <span>
          {formatBalance(publicBal ?? "0")} {token.symbol}
        </span>
      )}
      {mode === "shield" && !!wallet.address && !balUnknown && (
        <button
          onClick={() => setAmount(publicBal ?? "0")}
          className="text-acid hover:text-acid2 font-data text-[0.65rem]"
        >
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
                  // The choice belongs to the withdrawal it was made for.
                  setSelfPay(false);
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
              text="The line where private meets public. Going in and coming out show on chain. What you do while shielded does not."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              Boundary
            </span>
          </span>
        </div>

        {/* Source panel */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex flex-wrap items-center justify-between mb-2 gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              {mode === "unshield" && <MaskLogo className="h-2 w-auto text-acid" />}
              {mode === "shield" ? "Public wallet" : "Shielded balance"}
              {wallet.address && (
                <span className="font-data text-[0.62rem] text-faint/70 normal-case tracking-normal">
                  {shortAddr(wallet.address)}
                </span>
              )}
            </span>
            {mode === "shield" ? publicSide : shieldedSide}
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <input
              className={`amount min-w-0 ${amountSize(amount || "0")} text-bone placeholder:text-faint outline-none font-data tracking-tight`}
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
          {usd && <div className="mt-2 text-[0.7rem] text-faint font-data">{usd}</div>}
          {/* Stated before someone hits it, not after. A ceiling you only meet
              by bouncing off it reads as a fault; one you can see reads as a
              decision. The second line is there because the question a limit
              raises is always whether the way out has one too.

              It keeps its block in both states so nothing shifts under the
              cursor when the limit is crossed; only the colour moves. */}
          {mode === "shield" && (
            <p
              className={`mt-3 px-3 py-2 text-[0.7rem] leading-relaxed transition-colors ${
                overCap ? "bg-warn/10 text-warn" : "bg-ink3 text-faint"
              }`}
            >
              Beta caps a deposit at ${BETA_USD_CAP}. Withdrawals are not capped, so whatever you
              put in comes back out on your say so.
            </p>
          )}
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
          <div className="flex flex-wrap items-center justify-between mb-2 gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
              {mode === "shield" && <MaskLogo className="h-2 w-auto text-acid" />}
              {mode === "shield" ? "Shielded balance" : "Public wallet"}
              {wallet.address && (
                <span className="font-data text-[0.62rem] text-faint/70 normal-case tracking-normal">
                  {shortAddr(wallet.address)}
                </span>
              )}
            </span>
            {mode === "shield" ? shieldedSide : publicSide}
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`min-w-0 truncate ${amountSize(amt > 0 ? amount : "0")} font-data tracking-tight text-acid`}
              title={amt > 0 ? amount : undefined}
            >
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
              <InfoTip text="Fires the transactions at random moments across the window, not in one burst. Timing stops grouping them. Off sends them back to back." />
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
            {spread && <Row k="Spread" v={`${spread} window · random moments · keep this tab open`} />}
            {/* Every part is its own transaction, so it is its own signature.
                Worth saying up front: a plan that splits into six is six trips
                to the wallet, and behind a spread they arrive minutes apart. */}
            <Row
              k="Wallet confirmations"
              v={
                relayChecking
                  ? "not known yet"
                  : gasless
                    ? "None"
                    : execParts.length === 1
                      ? "1"
                      : `${execParts.length}${spread ? ", at random moments" : ", back to back"}`
              }
              accent={gasless}
              busy={relayChecking}
            />
            <Row k="Proving" v="In your browser" accent />
            {/* Until the relayer has answered, who pays is genuinely unknown.
                Printing "You" and flipping to "The relayer" a moment later is
                stating a fact nobody has checked, on the row that decides
                whether a wallet is about to open. Once it has answered, an
                unshield gets the choice rather than the verdict: relayed keeps
                the wallet off this transaction, self-paid keeps the fee out of
                the notes — the CLI's --self, as two chips. */}
            {mode === "unshield" && relay && !relayChecking ? (
              <div className="flex items-center justify-between text-xs gap-4">
                <span className="flex items-center gap-1.5 text-faint font-data shrink-0">
                  Gas payer
                  <InfoTip text="The relayer submits each withdrawal and charges its fee from the notes being spent. Pay the gas yourself and no fee leaves the notes — your wallet submits instead, one confirmation per withdrawal." />
                </span>
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
              </div>
            ) : (
              <Row
                k="Gas payer"
                v={
                  relayChecking
                    ? "checking the relayer"
                    : gasless
                      ? "The relayer"
                      : mode === "shield"
                        ? "You, per deposit"
                        : "You, per withdrawal"
                }
                accent={gasless}
                busy={relayChecking}
              />
            )}
            {/* The arithmetic in full, whoever pays. A cost with no number
                beside it is not a price, and one that only appears after the
                fact is a number nobody agreed to. */}
            <Row k="You receive" v={`${fmtUnits(requiredTotal, token.decimals)} ${token.symbol}`} />
            {gasless && relay ? (
              <>
                <Row
                  k="Relayer fee"
                  v={`${fmtUnits(relayFeeTotal, token.decimals)} ${token.symbol}${
                    execParts.length > 1
                      ? ` · ${execParts.length} × ${fmtUnits(relay.fee, token.decimals)}`
                      : ""
                  }`}
                />
                <Row
                  k="Leaves your notes"
                  v={`${fmtUnits(drawnFromNotes, token.decimals)} ${token.symbol}`}
                  accent
                />
                {/* Not a blocker. The withdrawal is perfectly valid; it is just
                    a bad trade at this size, and only the person doing it can
                    decide whether that matters. */}
                {feeIsSteep && (
                  <p className="text-[0.7rem] text-warn leading-relaxed pt-1">
                    That fee is {feeSharePct.toFixed(0)}% of what you are withdrawing. It costs one
                    spend&apos;s gas whatever the size, so a larger withdrawal pays the same fee and
                    a smaller share of it.
                  </p>
                )}
              </>
            ) : (
              <Row
                k="Network fee"
                v={
                  selfGas === null
                    ? "estimating"
                    : `~${fmtUnits(selfGas, 18)} ${net.currency.symbol}${
                        execParts.length > 1 ? ` · ${execParts.length} transactions` : ""
                      }`
                }
                busy={selfGas === null}
              />
            )}
          </div>
        )}

        {/* The way past the fee, on the screen that named it: a withdrawal the
            fee has trapped is exactly what the self-paid switch exists for. */}
        {feeTrapped && insufficient && (
          <div className="mt-3 px-3 py-2 bg-ink3 fade-up">
            <p className="text-[0.7rem] text-faint leading-relaxed">
              It is the relayer&apos;s fee this balance cannot cover — the withdrawal itself fits.
              Pay the gas from your wallet and the notes owe nothing on top.
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
          ) : needsUnlockFirst ? (
            // The step that is actually in the way, as something you can press.
            // This used to be the disabled label, which told someone to unlock
            // while refusing the click that would.
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
                "Unlock to see what you can withdraw"
              )}
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
        {!unlocked
          ? "One signature derives your shielded keys. They never leave this tab."
          : mode === "shield"
            ? "Once shielded, every note looks like every other."
            : "Withdrawals prove in your browser and land at your wallet."}
      </p>

      {/* Shielding starts from the wallet, so the picker offers what the wallet
          can reach, pasted addresses included. Unshielding starts from the
          shielded book and can only reach what is in it: offering the boundary
          list there let someone pick a token they hold nothing of, while the
          one they actually held was missing from the list entirely. */}
      {mode === "shield" ? (
        <TokenModal
          open={picking}
          tokens={BOUNDARY_TOKENS}
          allowImport
          owner={wallet.address as `0x${string}` | null}
          onClose={() => setPicking(false)}
          onSelect={pick}
        />
      ) : (
        <TokenModal
          open={picking}
          assets={shieldedAssets}
          assetsLoading={shieldedLoading}
          emptyNote={
            unlocked
              ? "Nothing shielded yet. Shield something and it lands here, ready to withdraw."
              : "Unlock your shielded account to see what you can withdraw."
          }
          onClose={() => setPicking(false)}
          onSelect={pick}
        />
      )}

      <BoundaryConfirmModal
        open={confirming}
        mode={mode}
        token={token}
        amount={amount}
        usd={usd}
        parts={execParts}
        planLabel={!exact && parts.length > 0 ? planLabel : undefined}
        remainderLabel={
          !exact && remainder > 0n
            ? `${fmtUnits(remainder, token.decimals)} ${token.symbol} stays ${mode === "shield" ? "public" : "shielded"}`
            : undefined
        }
        exact={exact}
        spread={spread ?? undefined}
        gasless={gasless}
        relayFee={gasless ? `${fmtUnits(relayFeeTotal, token.decimals)} ${token.symbol}` : undefined}
        relayDrawn={gasless ? `${fmtUnits(drawnFromNotes, token.decimals)} ${token.symbol}` : undefined}
        networkFee={
          !gasless && selfGas !== null ? `~${fmtUnits(selfGas, 18)} ${net.currency.symbol}` : undefined
        }
        steepFeePct={gasless && feeIsSteep ? feeSharePct : undefined}
        progress={shielded.progress}
        onExecute={execute}
        onClose={closeConfirm}
      />
    </div>
  );
}

function Row({ k, v, accent, busy }: { k: string; v: string; accent?: boolean; busy?: boolean }) {
  return (
    // items-start, not centre: a fee carried to the last base unit wraps to a
    // second line rather than running off the card, and its label stays put.
    <div className="flex items-start justify-between text-xs gap-4">
      <span className="text-faint font-data shrink-0">{k}</span>
      <span
        className={`flex items-center gap-2 font-data text-right min-w-0 break-all ${
          busy ? "text-faint" : accent ? "text-acid" : "text-muted"
        }`}
      >
        {busy && <Spinner className="h-3 w-3 shrink-0" />}
        {v}
      </span>
    </div>
  );
}
