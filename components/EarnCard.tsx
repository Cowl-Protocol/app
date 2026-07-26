"use client";

// The earn program, shown before season one opens.
//
// The card carries the full shape of the thing so nothing moves when it goes
// live: your earnings, the season's pot, the ways to earn and how the pot
// pays out. What it never carries is a formula, an allocation or a date —
// the mechanism is public, the numbers are not.
import Link from "next/link";
import { useShielded } from "./ShieldedProvider";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";

// Flips when season one opens and the card starts counting for real.
const LIVE = false;

const WAYS = [
  { k: "Transact", d: "Every private transaction counts. Shield in, unshield out, send, trade. The more you move, the bigger your share" },
  { k: "Stay private", d: "Transactions nobody can see still count. You show yours when you claim, to us and no one else" },
  { k: "Hold", d: "A slice of every season goes to the ones holding COWL through it" },
];

export default function EarnCard() {
  const shielded = useShielded();

  return (
    <div className="w-full max-w-[460px] mx-auto">
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <span className="label-mono text-[0.72rem] text-bone">Earn</span>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="Each season sets a fixed pot of COWL. Every transaction grows your share of it, and payouts land in your shielded balance. The chain records that a distribution happened, never who earned what."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              {LIVE ? "Season one" : "Coming soon"}
            </span>
          </span>
        </div>

        {/* Your earnings */}
        <div className="bg-ink2 p-4 my-1">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <p className="flex items-center gap-1.5 label-soft text-faint">
              <MaskLogo className="h-2 w-auto text-acid" />
              Your earnings
            </p>
            <span className="label-soft text-faint">Season one</span>
          </div>
          <p className="font-data text-3xl text-bone tracking-tight">
            — <span className="text-base text-muted">COWL</span>
          </p>
          <p className="text-[0.7rem] text-faint mt-1.5 leading-relaxed">
            Season one opens the count. Your share updates with every move you make, here and
            nowhere else.
          </p>
        </div>

        {/* The season, in numbers */}
        <div className="grid grid-cols-3 gap-1 my-1">
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Pot</p>
            <p className="font-data text-xl text-acid tracking-tight">—</p>
          </div>
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Paid out</p>
            <p className="font-data text-xl text-bone tracking-tight">—</p>
          </div>
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Earners</p>
            <p className="font-data text-xl text-bone tracking-tight">—</p>
          </div>
        </div>

        {/* How you earn */}
        <div className="mt-4 px-1 space-y-4">
          {WAYS.map((w, i) => (
            <div key={w.k} className="flex gap-3">
              <span className="shrink-0 h-6 w-6 flex items-center justify-center bg-ink3 text-acid label-mono text-[0.62rem]">
                {i + 1}
              </span>
              <div>
                <p className="label-soft text-bone">{w.k}</p>
                <p className="text-xs text-muted mt-0.5">{w.d}</p>
              </div>
            </div>
          ))}
        </div>

        {/* How the pot pays */}
        <div className="mt-4 px-1 space-y-2">
          <Row k="Season pot" v="fixed the day it opens" />
          <Row k="Your cut" v="your share of the season's moves" accent />
          <Row k="Payout" v="private, straight to your shielded book" accent />
          <Row k="On the tape" v="a distribution happened, nothing more" />
          <Row k="Small cuts" v="roll into the next season" />
          <Row k="Funded by" v="the hood's fees" />
        </div>

        {/* Action */}
        <div className="mt-4">
          <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
            Season one coming soon
          </button>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        {shielded.poolReady ? (
          <>
            It is{" "}
            <Link href="/shield" className="text-muted hover:text-bone transition-colors">
              open today
            </Link>
            . Earnings arrive the way everything here moves, unread.
          </>
        ) : (
          "Earnings arrive the way everything here moves, unread."
        )}
      </p>
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
