"use client";

// Earn, the trade revenue share.
//
// Every COWL trade pays a 1% pool fee. The launchpad keeps its cut, and whatever
// reaches Cowl is split in half: half to the protocol, half back to the trader who
// paid it. One condition, and it is the whole of it: the address you trade from has to
// have shielded into the pool at least once.
//
// The card does almost nothing. Who traded, who shielded and what anyone is owed was
// worked out days earlier by the offline indexer, so this reads one static file and two
// numbers off the chain. It scans nothing and there is no backend behind it.
//
// The previous version described a season pot paid privately into your shielded book.
// That mechanism was superseded, so none of that copy survived: the payout is now a
// public claim to the trading address, and there is no pot to take a share of.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useWalletClient } from "wagmi";

import { useWallet } from "@/lib/useWallet";
import { readEarn, buildClaim, EARN_ADDRESS, type EarnStatus } from "@/lib/earn";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";

// Flips when the fee redirect points at the contract and the first root is live.
const LIVE = false;

const STEPS = [
  {
    k: "Shield once",
    d: "One deposit into the shielded pool, from the wallet you trade with. Any amount, and you can unshield again a minute later",
  },
  {
    k: "Trade COWL",
    d: "Anywhere you like. If it touches the COWL pool it counts, and the address that shielded is the address that earns",
  },
  {
    k: "Claim whenever",
    d: "Everything you have earned so far, in one transaction, on your own schedule",
  },
];

const fmt = (v: bigint, dp = 2) => {
  const [whole, frac = ""] = formatUnits(v, 18).split(".");
  return dp === 0 ? whole : `${whole}.${frac.padEnd(dp, "0").slice(0, dp)}`;
};

export default function EarnCard() {
  const wallet = useWallet();
  const { data: walletClient } = useWalletClient();

  const [status, setStatus] = useState<EarnStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = wallet.address;

  const refresh = useCallback(async () => {
    if (!address || !EARN_ADDRESS) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await readEarn(address as `0x${string}`));
    } catch {
      // A read failure is not a claim failure. Show nothing rather than invent a zero,
      // because a zero here reads as "you earned nothing" and that would be a lie.
      setStatus(null);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(async () => {
    if (!walletClient || status?.state !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      await walletClient.writeContract(buildClaim(status));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "The claim did not go through");
    } finally {
      setBusy(false);
    }
  }, [walletClient, status, refresh]);

  const ready = status?.state === "ready" ? status : null;
  const hasSomething = !!ready && (ready.claimableCowl > 0n || ready.claimableWeth > 0n);

  return (
    <div className="w-full max-w-[460px] mx-auto">
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <span className="label-mono text-[0.72rem] text-bone">Earn</span>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="Every COWL trade pays a 1% pool fee. Whatever reaches Cowl is split in half, and your half is 35% of the fee you paid yourself. It is not a share of a common pot, so nobody else showing up moves your number."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              {LIVE ? "Live" : "Coming soon"}
            </span>
          </span>
        </div>

        {/* What you can claim */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <p className="flex items-center gap-1.5 label-soft text-faint">
              <MaskLogo className="h-2 w-auto text-acid" />
              Yours to claim
            </p>
            {LIVE && ready && ready.claimedCowl > 0n && (
              <span className="label-soft text-faint">{fmt(ready.claimedCowl)} taken</span>
            )}
          </div>
          <p className="font-data text-3xl text-bone tracking-tight">
            {LIVE && ready ? fmt(ready.claimableCowl) : "—"}{" "}
            <span className="text-base text-muted">COWL</span>
          </p>
          {LIVE && ready && ready.claimableWeth > 0n && (
            <p className="font-data text-sm text-acid mt-1">plus {fmt(ready.claimableWeth, 6)} ETH</p>
          )}
          <p className="text-[0.7rem] text-faint mt-1.5 leading-relaxed">
            {statusLine(status, address)}
          </p>
        </div>

        {/* The mechanism, in numbers */}
        <div className="grid grid-cols-3 gap-1 my-1">
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Fee back</p>
            <p className="font-data text-xl text-acid tracking-tight">35%</p>
          </div>
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Your fee</p>
            <p className="font-data text-xl text-bone tracking-tight">0.65%</p>
          </div>
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">To deposit</p>
            <p className="font-data text-xl text-bone tracking-tight">0</p>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-4 px-1 space-y-4">
          {STEPS.map((s, i) => (
            <div key={s.k} className="flex gap-3">
              <span className="shrink-0 h-6 w-6 flex items-center justify-center bg-ink3 text-acid label-mono text-[0.62rem]">
                {i + 1}
              </span>
              <div>
                <p className="label-soft text-bone">{s.k}</p>
                <p className="text-xs text-muted mt-0.5">{s.d}</p>
              </div>
            </div>
          ))}
        </div>

        {/* The terms */}
        <div className="mt-4 px-1 space-y-2">
          <Row k="Your share" v="35% of the fee you paid" accent />
          <Row k="Dilution" v="none, the figure is your own" accent />
          <Row k="Staking" v="none, nothing is locked" />
          <Row k="Paid in" v="COWL and ETH, so the gas is covered" />
          <Row k="Claim window" v="any time, nothing expires" />
          <Row k="Funded by" v="the fee the pool already charges" />
        </div>

        {/* Action */}
        <div className="mt-4">
          {!LIVE ? (
            <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
              Coming soon
            </button>
          ) : !address ? (
            <button
              onClick={wallet.connect}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:opacity-90 transition-opacity"
            >
              Connect wallet
            </button>
          ) : wallet.wrongNetwork ? (
            <button
              onClick={wallet.switchNetwork}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:opacity-90 transition-opacity"
            >
              Switch to {wallet.network.label}
            </button>
          ) : (
            <button
              onClick={claim}
              disabled={busy || !hasSomething}
              className={`w-full label-mono text-sm py-4 transition-opacity ${
                hasSomething && !busy
                  ? "bg-acid text-ink hover:opacity-90"
                  : "bg-ink3 text-faint cursor-default"
              }`}
            >
              {busy
                ? "Claiming"
                : hasSomething
                  ? `Claim ${fmt(ready.claimableCowl)} COWL`
                  : "Nothing to claim"}
            </button>
          )}
          {error && <p className="text-xs text-center mt-2 text-muted">{error}</p>}
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        Every trade already pays the fee.{" "}
        <Link href="/shield" className="text-muted hover:text-bone transition-colors">
          Shield once
        </Link>{" "}
        and your share of it starts coming back.
      </p>
    </div>
  );
}

/* One line under the figure, matched to the state. Each one says what to do next, and
   none of them fakes a number the chain has not confirmed. */
function statusLine(status: EarnStatus | null, address: string | null): string {
  if (!LIVE) {
    return "Shield once from the wallet you trade with, and every COWL trade after that counts.";
  }
  if (!address) return "Connect the wallet you trade COWL with.";
  if (!status) return "Could not read your share just now. Nothing is lost, try again in a moment.";

  switch (status.state) {
    case "not-live":
      return "No allocation has been published yet.";
    case "none":
      return "Nothing here yet. Shield once from this wallet, then every COWL trade counts.";
    case "stale":
      // The file disagrees with the chain, so every figure in it is meaningless. Saying
      // so is the only honest move; showing a number anyway would be worse than none.
      return "The published allocation does not match the one on chain, so no figure here is safe to show.";
    case "ready":
      return status.claimableCowl > 0n || status.claimableWeth > 0n
        ? "Yours whenever you want it. One transaction takes all of it."
        : "All caught up. Your next trade adds to this.";
  }
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs gap-4">
      <span className="text-faint font-data shrink-0">{k}</span>
      <span className={`font-data text-right ${accent ? "text-acid" : "text-muted"}`}>{v}</span>
    </div>
  );
}
