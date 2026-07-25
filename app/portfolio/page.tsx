"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useWallet, shortAddr } from "@/lib/useWallet";
import { TOKENS, tokenMetaForField, type Token } from "@/lib/tokens";
import { useHoldings } from "@/lib/holdings";
import { formatBalance, formatUnitsExact, usdOf } from "@/lib/prices";
import { fetchTokenPriceUsd } from "@/lib/tokenPrice";
import { usePoolStats } from "@/lib/pool";
import { useShielded } from "@/components/ShieldedProvider";
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
            <PrivateCard wallet={wallet} />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PublicCard({ wallet }: { wallet: WalletState }) {
  const { address: walletAddress, getBalance } = wallet;

  // The native coin is read from the chain; everything else is whatever the
  // address is discovered to hold, so a wallet with tokenized Apple in it shows
  // tokenized Apple without anyone pasting a contract address first.
  const { holdings, loading } = useHoldings(walletAddress as `0x${string}` | null);
  const native = TOKENS[0]!;

  // null = the read failed, which is not the same as zero.
  const [nativeBal, setNativeBal] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!walletAddress) {
      setNativeBal(null);
      return;
    }
    getBalance(native).then((b) => {
      if (alive) setNativeBal(b);
    });
    return () => {
      alive = false;
    };
  }, [walletAddress, getBalance, native]);

  const rows: { token: Token; amount: string; rate: number | null }[] = [
    { token: native, amount: nativeBal ?? "0", rate: null },
    ...holdings.map((h) => ({
      token: h.token,
      amount: formatUnits(h.value, h.token.decimals),
      rate: h.rate,
    })),
  ];

  const [prices, setPrices] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let alive = true;
    Promise.all(
      rows.map(async (r) => {
        const key = r.token.native ? "native" : r.token.address.toLowerCase();
        return [key, await fetchTokenPriceUsd(r.token, r.rate)] as const;
      }),
    ).then((entries) => {
      if (alive) setPrices(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, holdings.length]);

  const priceOf = (t: Token) => prices[t.native ? "native" : t.address.toLowerCase()] ?? null;
  // Only priced holdings count toward the total, so it never quietly includes
  // a token valued at a number nobody supplied.
  const total = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0) * (priceOf(r.token) ?? 0), 0);
  const anyPriced = rows.some((r) => priceOf(r.token) !== null);

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
              {!anyPriced
                ? "—"
                : `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </p>
            <p className="text-[0.7rem] text-faint mt-1.5">
              Visible to anyone with your address. That&apos;s this side of the ledger.
            </p>
          </div>
          <div>
            {rows.map((r) => {
              const known = !r.token.native || nativeBal !== null;
              const bal = parseFloat(r.amount) || 0;
              return (
                <div key={r.token.address} className="flex items-center gap-3 px-1 py-3">
                  <TokenGlyph symbol={r.token.symbol} src={r.token.logoURI} />
                  <span className="flex flex-col flex-1 min-w-0">
                    <span className="text-sm text-bone truncate">{r.token.symbol}</span>
                    <span className="text-xs text-faint truncate">{r.token.name}</span>
                  </span>
                  <span className="flex flex-col items-end shrink-0">
                    {known ? (
                      <>
                        <span className="font-data text-sm text-bone">{formatBalance(r.amount)}</span>
                        <span className="text-xs text-faint font-data">
                          {usdOf(bal, priceOf(r.token)) ?? ""}
                        </span>
                      </>
                    ) : (
                      <span className="font-data text-xs text-faint">unavailable</span>
                    )}
                  </span>
                </div>
              );
            })}
            {loading && <p className="px-1 py-2 text-xs text-faint">Looking for your tokens…</p>}
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

function PrivateCard({ wallet }: { wallet: WalletState }) {
  const stats = usePoolStats();
  const shielded = useShielded();
  const [copied, setCopied] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the text is visible to copy manually */
    }
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

  const unlocked = shielded.status === "ready";

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
          tip="Shielded values in the pool's tree. The chain sees how many exist, never who owns which."
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

      {/* The owner's view — unlocked in this tab, or an invitation to */}
      <div className="bg-ink2 p-4 mt-2">
        <div className="flex items-center justify-between mb-2 gap-3">
          <p className="label-soft text-faint">Your shielded book</p>
          {unlocked && (
            <span className="flex items-center gap-3">
              <button
                onClick={() => shielded.refresh()}
                className="label-soft text-muted hover:text-bone"
              >
                {shielded.syncing ? "Syncing…" : "Refresh"}
              </button>
              <button onClick={shielded.lock} className="label-soft text-faint hover:text-bone">
                Lock
              </button>
            </span>
          )}
        </div>

        {unlocked ? (
          <>
            {shielded.balances.length === 0 ? (
              <p className="text-xs text-muted leading-relaxed">
                No notes yet. Shield something and it appears here, visible only in this tab.
              </p>
            ) : (
              <div className="space-y-2">
                {shielded.balances.map((b) => {
                  const meta = tokenMetaForField(b.token);
                  return (
                    <div key={meta.symbol} className="flex items-center justify-between bg-ink px-3 py-2.5">
                      <span className="text-sm text-bone">{meta.symbol}</span>
                      <span className="flex flex-col items-end">
                        <span className="font-data text-sm text-acid">
                          {formatUnitsExact(b.amount, meta.decimals)}
                        </span>
                        <span className="text-[0.65rem] text-faint font-data">
                          {b.notes} {b.notes === 1 ? "note" : "notes"}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {shielded.paymentAddress && (
              <div className="mt-3">
                <p className="label-soft text-faint mb-1.5">Payment address</p>
                <div className="flex items-center justify-between bg-ink px-3 py-2.5 gap-3">
                  <code className="font-data text-[0.7rem] text-muted truncate">
                    {shielded.paymentAddress.slice(0, 18)}…{shielded.paymentAddress.slice(-6)}
                  </code>
                  <button
                    onClick={() => copy(shielded.paymentAddress!)}
                    className="label-soft text-muted hover:text-bone shrink-0"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-[0.68rem] text-faint mt-1.5 leading-relaxed">
                  Anyone can send to it privately, from the app or with cowl send.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted leading-relaxed">
              One wallet signature derives your shielded keys and reads your private balance, in
              this tab only. Nothing touches a server.
            </p>
            <div className="mt-3">
              {wallet.address ? (
                <button
                  onClick={unlock}
                  disabled={shielded.status === "unlocking"}
                  className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
                >
                  {shielded.status === "unlocking" ? "Check your wallet…" : "Unlock shielded account"}
                </button>
              ) : (
                <button
                  onClick={wallet.connect}
                  disabled={wallet.connecting}
                  className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
                >
                  {wallet.connecting ? "Connecting…" : "Connect wallet"}
                </button>
              )}
              {unlockError && <p className="text-xs text-[#ff6b6b] mt-2 text-center">{unlockError}</p>}
            </div>
            <p className="text-[0.68rem] text-faint mt-3 leading-relaxed">
              The terminal reads the same pool: cowl balance.
            </p>
          </>
        )}
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
