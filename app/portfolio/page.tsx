"use client";

import { useEffect, useState } from "react";
import { useWallet, shortAddr } from "@/lib/useWallet";
import { TOKENS } from "@/lib/tokens";
import { USD } from "@/lib/prices";
import { usePoolStats } from "@/lib/pool";
import Header from "@/components/Header";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";
import MaskLogo from "@/components/MaskLogo";
import InfoTip from "@/components/InfoTip";
import { TokenGlyph } from "@/components/TokenModal";

type WalletState = ReturnType<typeof useWallet>;

function fmt(n: number, max = 4): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export default function Portfolio() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 px-4 py-10 md:py-14">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10 max-w-lg mx-auto">
            <h1 className="display text-4xl md:text-5xl leading-[1.05]">
              One owner. <em>Two books.</em>
            </h1>
            <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
              The public book anyone can read. The private one is yours alone.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4 items-start">
            <PublicCard wallet={wallet} />
            <PrivateCard />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PublicCard({ wallet }: { wallet: WalletState }) {
  const [balances, setBalances] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    if (!wallet.address) {
      setBalances({});
      return;
    }
    Promise.all(TOKENS.map(async (t) => [t.symbol, await wallet.getBalance(t)] as const)).then(
      (rows) => {
        if (alive) setBalances(Object.fromEntries(rows));
      },
    );
    return () => {
      alive = false;
    };
  }, [wallet, wallet.address]);

  const total = TOKENS.reduce(
    (sum, t) => sum + (parseFloat(balances[t.symbol] ?? "0") || 0) * (USD[t.symbol] ?? 0),
    0,
  );

  return (
    <div className="bg-card p-5 fade-up">
      <div className="flex items-center justify-between mb-5">
        <span className="label-mono text-[0.72rem] text-bone">Public</span>
        {wallet.address ? (
          <span className="font-data text-[0.68rem] text-muted px-2 py-1 bg-ink2">
            {shortAddr(wallet.address)}
          </span>
        ) : (
          <span className="label-mono text-[0.62rem] text-faint px-2 py-1 bg-ink2">
            Not connected
          </span>
        )}
      </div>

      {wallet.address ? (
        <>
          <div className="bg-ink2 p-4 mb-1">
            <p className="label-soft text-faint mb-1.5">Total value</p>
            <p className="font-data text-3xl text-bone tracking-tight">
              ${total.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </p>
            <p className="text-[0.7rem] text-faint mt-1.5">
              Visible to anyone with your address — that&apos;s this side of the ledger.
            </p>
          </div>
          <div>
            {TOKENS.map((t) => {
              const bal = parseFloat(balances[t.symbol] ?? "0") || 0;
              return (
                <div key={t.symbol} className="flex items-center gap-3 px-1 py-3">
                  <TokenGlyph symbol={t.symbol} />
                  <span className="flex flex-col flex-1">
                    <span className="text-sm text-bone">{t.symbol}</span>
                    <span className="text-xs text-faint">{t.name}</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="font-data text-sm text-bone">{fmt(bal)}</span>
                    <span className="text-xs text-faint font-data">
                      ${fmt(bal * (USD[t.symbol] ?? 0), 2)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="bg-ink2 p-6 text-center">
          <p className="text-xs text-muted leading-relaxed mb-4">
            Connect a wallet to read this side of your book.
          </p>
          <button
            onClick={wallet.connect}
            disabled={wallet.connecting}
            className="label-mono text-xs px-6 py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
          >
            {wallet.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      )}
    </div>
  );
}

function PrivateCard() {
  const stats = usePoolStats();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText("cowl balance");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the command is visible to copy manually */
    }
  };

  return (
    <div className="bg-card p-5 fade-up">
      <div className="flex items-center justify-between mb-5">
        <span className="flex items-center gap-2">
          <MaskLogo className="h-3 w-auto text-acid" />
          <span className="label-mono text-[0.72rem] text-bone">Private</span>
        </span>
        <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
          Shielded pool
        </span>
      </div>

      {/* What the chain shows — the pool as one crowd, no owners */}
      <div className="grid grid-cols-2 gap-1 mb-1">
        <Stat k="Pooled ETH" v={stats ? fmt(parseFloat(stats.eth), 6) : "…"} />
        <Stat k="Pooled USDG" v={stats ? fmt(parseFloat(stats.usdg), 2) : "…"} />
        <Stat
          k="Notes"
          tip="Shielded values in the pool's tree. The chain sees how many exist — never who owns which."
          v={stats ? String(stats.notes) : "…"}
        />
        <Stat
          k="Root"
          tip="The tree's current fingerprint. Spends prove membership against it without pointing at any note."
          tipAlign="right"
          v={stats ? `${stats.root.slice(0, 10)}…` : "…"}
          mono
        />
      </div>
      <p className="text-[0.7rem] text-faint px-1 py-2 leading-relaxed">
        This is everything the chain shows: one pool, one crowd. Which notes are yours isn&apos;t
        written anywhere but with you.
      </p>

      {/* The owner's view lives with the keys */}
      <div className="bg-ink2 p-4 mt-2">
        <p className="label-soft text-faint mb-2">Your shielded book</p>
        <p className="text-xs text-muted leading-relaxed">
          Notes never touch a server — they live with your keys, on your machine. Read your private
          balance from the terminal:
        </p>
        <div className="mt-3 flex items-center justify-between bg-ink px-3 py-2.5">
          <code className="font-data text-[0.8rem] text-acid">cowl balance</code>
          <button onClick={copy} className="label-soft text-muted hover:text-bone shrink-0 ml-3">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <a
          href="https://cowlprotocol.com/docs"
          className="block mt-3 label-soft text-faint hover:text-bone"
        >
          Install the CLI → cowlprotocol.com/docs
        </a>
      </div>
    </div>
  );
}

function Stat({
  k,
  v,
  tip,
  tipAlign,
  mono,
}: {
  k: string;
  v: string;
  tip?: string;
  tipAlign?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <div className="bg-ink2 p-4">
      <p className="flex items-center gap-1.5 label-soft text-faint mb-1.5">
        {k}
        {tip && <InfoTip text={tip} align={tipAlign} />}
      </p>
      <p className={`text-bone tracking-tight ${mono ? "font-data text-sm pt-1" : "font-data text-xl"}`}>{v}</p>
    </div>
  );
}
