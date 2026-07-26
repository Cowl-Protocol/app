"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type Token } from "@/lib/tokens";
import { activeNetwork } from "@/lib/networks";
import { decompose, groupParts, maxAfterFee, MAX_BOUNDARY_TXS, sharedCeiling, tiersFor } from "@/lib/denominations";
import { formatBalance, formatUnitsExact, usdOf } from "@/lib/prices";
import { useAssets, useShieldedAssets } from "@/lib/assets";
import { useRelayQuote, useSelfGasEstimate } from "@/lib/relay";
import { useTokenPrice } from "@/lib/tokenPrice";
import { parseWindow } from "@/lib/spread";
import { shortAddr, type useWallet } from "@/lib/useWallet";
import BoundaryConfirmModal, { type BoundaryMode } from "./BoundaryConfirmModal";
import { useShielded } from "./ShieldedProvider";
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
  const { assets: shieldedAssets } = useShieldedAssets(
    unlocked ? shielded.balances : [],
    publicAssets,
  );

  // Asked before anything signs, so the rows below can name the gas payer and
  // the confirmation count truthfully rather than promising gasless and then
  // opening a wallet.
  const { quote: relay } = useRelayQuote(tokenField, mode === "unshield");
  const gasless = mode === "unshield" && !!relay;
  // The other half of the same question: what it costs when the wallet pays.
  const selfGas = useSelfGasEstimate(execParts.length, !gasless && value > 0n);

  // The relayer's fee is paid out of the same notes, once per part, so it is
  // part of what the book has to cover. Leaving it out let an amount pass every
  // check on screen and then fail at planning, with the notes short by exactly
  // the fee nobody had counted.
  const relayFeeTotal = gasless && relay ? relay.fee * BigInt(execParts.length) : 0n;
  const drawnFromNotes = requiredTotal + relayFeeTotal;

  const amt = parseFloat(amount) || 0;
  const balUnknown = publicBal === null;
  const bal = parseFloat(publicBal ?? "0") || 0;
  const insufficient =
    mode === "shield"
      ? !!wallet.address && !balUnknown && amt > bal
      : unlocked && drawnFromNotes > shieldedBal;
  const belowTier = !exact && value > 0n && parts.length === 0;
  const tooMany = !exact && parts.length > MAX_BOUNDARY_TXS;
  const needsUnlockFirst = mode === "unshield" && !unlocked;
  const ready =
    !!wallet.address &&
    !wallet.wrongNetwork &&
    amt > 0 &&
    !insufficient &&
    !belowTier &&
    !tooMany &&
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
  if (insufficient) {
    label =
      gasless && relayFeeTotal > 0n && requiredTotal <= shieldedBal
        ? `Not enough for the amount plus the relayer fee`
        : `Insufficient ${mode === "shield" ? "" : "shielded "}${token.symbol}`;
  }
  if (needsUnlockFirst) label = "Unlock to see what you can withdraw";

  const pick = (t: Token) => {
    setToken(t);
    setAmount("");
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
  };

  // Priced off the venue's own pools, whatever the token is — including one
  // pasted in a minute ago. No price, no USD line.
  const price = useTokenPrice(token);
  const usd = usdOf(amt, price);

  const unlock = async () => {
    setUnlockError(null);
    try {
      await shielded.unlock();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUnlockError(/rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0] ?? msg);
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
        : shielded.unshieldExec(args);
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
          <span>
            {formatUnitsExact(shieldedBal, token.decimals)} {token.symbol}
          </span>
          {mode === "unshield" && shieldedBal > 0n && (
            <button
              // MAX has to leave the relayer's fee behind, or it fills the field
              // with an amount the book can never cover.
              onClick={() =>
                setAmount(
                  formatUnits(
                    maxAfterFee(shieldedBal, relay?.fee ?? 0n, token.decimals, exact),
                    token.decimals,
                  ),
                )
              }
              className="text-acid hover:text-acid2 font-data text-[0.65rem]"
            >
              MAX
            </button>
          )}
          {shielded.syncing && (
            <span className="inline-block h-2 w-2 border-2 border-acid border-t-transparent rounded-full spin" />
          )}
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
          {shielded.status === "unlocking" ? "check your wallet…" : "unlock to view"}
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
              {wallet.address && (
                <span className="font-data text-[0.62rem] text-faint/70 normal-case tracking-normal">
                  {shortAddr(wallet.address)}
                </span>
              )}
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
              {wallet.address && (
                <span className="font-data text-[0.62rem] text-faint/70 normal-case tracking-normal">
                  {shortAddr(wallet.address)}
                </span>
              )}
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
            {spread && <Row k="Spread" v={`${spread} window · random moments · keep this tab open`} />}
            {/* Every part is its own transaction, so it is its own signature.
                Worth saying up front: a plan that splits into six is six trips
                to the wallet, and behind a spread they arrive minutes apart. */}
            <Row
              k="Wallet confirmations"
              v={
                gasless
                  ? "None"
                  : execParts.length === 1
                    ? "1"
                    : `${execParts.length}${spread ? ", at random moments" : ", back to back"}`
              }
              accent={gasless}
            />
            <Row k="Proving" v="In your browser" accent />
            <Row
              k="Gas payer"
              v={gasless ? "The relayer" : mode === "shield" ? "You, per deposit" : "You, per withdrawal"}
              accent={gasless}
            />
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
              </>
            ) : (
              <Row
                k="Network fee"
                v={
                  selfGas === null
                    ? "estimating…"
                    : `~${fmtUnits(selfGas, 18)} ${net.currency.symbol}${
                        execParts.length > 1 ? ` · ${execParts.length} transactions` : ""
                      }`
                }
              />
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
          ) : needsUnlockFirst ? (
            // The step that is actually in the way, as something you can press.
            // This used to be the disabled label, which told someone to unlock
            // while refusing the click that would.
            <button
              onClick={unlock}
              disabled={shielded.status === "unlocking"}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
            >
              {shielded.status === "unlocking" ? "Check your wallet…" : "Unlock to see what you can withdraw"}
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
            ? "Inside the pool, every note looks like every other."
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
          emptyNote={
            unlocked
              ? "Your shielded book is empty. Shield something and it shows up here."
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
        progress={shielded.progress}
        onExecute={execute}
        onClose={closeConfirm}
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
