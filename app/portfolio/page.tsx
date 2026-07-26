"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet, shortAddr } from "@/lib/useWallet";
import { ensureTokenMeta } from "@/lib/tokenMeta";
import { useAssets, useShieldedAssets, totalUsd, type Asset } from "@/lib/assets";
import AssetRow from "@/components/AssetRow";
import Spinner from "@/components/Spinner";
import { useShielded } from "@/components/ShieldedProvider";
import Header from "@/components/Header";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";
import MaskLogo from "@/components/MaskLogo";

type WalletState = ReturnType<typeof useWallet>;

export default function Portfolio() {
  const wallet = useWallet();
  // Read once here: the public card renders it, and the private card borrows it
  // to name and price the tokens it finds. Two reads would drift.
  const { assets: publicAssets, loading: publicLoading } = useAssets(
    wallet.address as `0x${string}` | null,
  );

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
              The private one is yours alone. The public book anyone can read.
            </p>
          </div>

          {/* Private leads. It is the balance this whole app exists to give
              someone, and putting the public side first framed it as the
              default with privacy as an extra. */}
          <div className="grid md:grid-cols-2 gap-4 items-start">
            <PrivateCard wallet={wallet} publicAssets={publicAssets} />
            <PublicCard wallet={wallet} assets={publicAssets} loading={publicLoading} />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PublicCard({
  wallet,
  assets,
  loading,
}: {
  wallet: WalletState;
  assets: Asset[];
  loading: boolean;
}) {
  // The same assets the picker offers, read the same way — one source, so a
  // balance can never be right on one screen and blank on the other.
  const { total, priced } = totalUsd(assets);

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
              {priced
                ? `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—"}
            </p>
            <p className="text-[0.7rem] text-faint mt-1.5">
              Visible to anyone with your address. That&apos;s this side of the ledger.
            </p>
          </div>
          <div>
            {assets.map((a) => (
              <AssetRow key={a.token.address} asset={a} loading={loading} />
            ))}
            {loading && (
              <p className="flex items-center gap-2 px-1 py-2 text-xs text-faint">
                <Spinner className="h-3 w-3" />
                Looking for your tokens
              </p>
            )}
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

function PrivateCard({ wallet, publicAssets }: { wallet: WalletState; publicAssets: Asset[] }) {
  const shielded = useShielded();
  const [copied, setCopied] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Bumped when the chain names a token the book was showing as a bare
  // address, so those rows re-render with their ticker and real decimals.
  const [, setMetaVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    ensureTokenMeta(shielded.balances.map((b) => b.token)).then((learned) => {
      if (alive && learned) setMetaVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [shielded.balances]);

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
  // Named and priced like any other holding, because that is what it is.
  const { assets, loading } = useShieldedAssets(unlocked ? shielded.balances : [], publicAssets);
  const { total, priced } = totalUsd(assets);

  return (
    <div className="bg-card p-5 fade-up">
      <div className="flex items-center justify-between mb-5">
        <span className="flex items-center gap-2">
          <MaskLogo className="h-3 w-auto text-acid" />
          <span className="label-mono text-[0.72rem] text-bone">Private</span>
        </span>
        {unlocked ? (
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
        ) : (
          <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">Locked</span>
        )}
      </div>

      {unlocked ? (
        <>
          <div className="bg-ink2 p-4 mb-1">
            <p className="label-soft text-faint mb-1.5">Total value</p>
            <p className="font-data text-3xl text-acid tracking-tight">
              {priced
                ? `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—"}
            </p>
            <p className="text-[0.7rem] text-faint mt-1.5">
              Nobody can read this from your address. Not the amounts, not what you hold.
            </p>
          </div>

          {assets.length === 0 && !loading ? (
            <p className="text-xs text-muted leading-relaxed px-1 py-3">
              Nothing here yet.{" "}
              <Link href="/shield" className="text-acid hover:text-acid2 transition-colors">
                Shield something
              </Link>{" "}
              and it shows up here, and nowhere else.
            </p>
          ) : (
            <div>
              {assets.map((a) => (
                <AssetRow key={a.token.address} asset={a} loading={loading} />
              ))}
              {loading && assets.length === 0 && (
                <p className="flex items-center gap-2 px-1 py-2 text-xs text-faint">
                  <Spinner className="h-3 w-3" />
                  Reading your private balance
                </p>
              )}
            </div>
          )}

          {shielded.paymentAddress && (
            <div className="mt-3">
              <p className="label-soft text-faint mb-1.5">Your payment address</p>
              <div className="flex items-center justify-between bg-ink2 px-3 py-2.5 gap-3">
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
                Share it to be paid privately. It never names your wallet.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="bg-ink2 p-4">
          <p className="text-xs text-muted leading-relaxed">
            One wallet signature unlocks your private balance, in this tab only. Your keys are
            built here and nothing touches a server.
          </p>
          <div className="mt-3">
            {wallet.address ? (
              <button
                onClick={unlock}
                disabled={shielded.status === "unlocking"}
                className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
              >
                {shielded.status === "unlocking" ? "Check your wallet…" : "Unlock private balance"}
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
        </div>
      )}
    </div>
  );
}
