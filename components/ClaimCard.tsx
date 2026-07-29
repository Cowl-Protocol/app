"use client";

// The airdrop claim, batch one.
//
// Four steps, in order: sign in with X, follow, open your shielded address,
// claim. The card walks them top to bottom and the claim API enforces every
// gate again server-side — this UI is a guide, never the guard.
//
// Delivery is a private send: the chain records that a distribution
// happened, never who claimed how much.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSignMessage } from "wagmi";
import { useWallet, shortAddr } from "@/lib/useWallet";
import { useShielded } from "./ShieldedProvider";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";

// Flips the day batch one opens. Off unless the environment says otherwise,
// so a local .env.local can light it up without touching code.
const LIVE = process.env.NEXT_PUBLIC_CLAIM_LIVE === "1";

const CONFIGURED_API = process.env.NEXT_PUBLIC_CLAIM_API ?? "https://claim.cowlprotocol.com";

/**
 * The API URL to actually call.
 *
 * Locally the session cookie is the whole game: a page on localhost talking to
 * an API on 127.0.0.1 is cross-SITE to a browser, so the cookie is dropped and
 * the user looks permanently signed out however well the login went. Keeping
 * the API on whichever loopback name the page was opened with keeps them one
 * site, so the cookie rides along. Real hosts are left alone.
 */
function apiBase(): string {
  if (typeof window === "undefined") return CONFIGURED_API;
  try {
    const api = new URL(CONFIGURED_API);
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"];
    if (loopback.includes(api.hostname) && loopback.includes(window.location.hostname)) {
      api.hostname = window.location.hostname;
      return api.origin;
    }
  } catch {
    /* configured value isn't a URL; fall through and use it as given */
  }
  return CONFIGURED_API;
}

type SessionInfo = {
  amount: string;
  quota: number;
  claimed: number;
  open: boolean;
  minAgeDays: number;
  xHandle: string;
  signedIn: boolean;
  handle?: string;
  xid?: string;
  accountOk?: boolean;
  claim?: { status: string; txHash: string | null } | null;
};

/** The exact text the wallet signs — one shape here and on the server. */
function claimMessage(xid: string, wallet: string, zcowl: string, issuedAt: string): string {
  return `Cowl airdrop batch 1\nX account: ${xid}\nWallet: ${wallet}\nDeliver to: ${zcowl}\nIssued: ${issuedAt}`;
}

export default function ClaimCard() {
  const wallet = useWallet();
  const shielded = useShielded();
  const { signMessageAsync } = useSignMessage();

  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [followed, setFollowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase()}/api/session`, { credentials: "include" });
      setInfo(await res.json());
      setApiDown(false);
    } catch {
      console.error(`claim service unreachable at ${apiBase()}`);
      setInfo(null);
      setApiDown(true);
    }
  }, []);

  // Keep the card current: retry a failed first load, tick the claimed
  // counter along, and catch up the moment the tab regains focus (the usual
  // return path from the X consent screen).
  useEffect(() => {
    if (!LIVE) return;
    refresh();
    const tick = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    if (new URLSearchParams(window.location.search).get("login") === "failed") {
      setError("X didn't complete the sign-in. Try again.");
    }
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const claimed = info?.claim ?? null;
  const step = useMemo(() => {
    if (!info?.signedIn) return 1;
    if (claimed) return 5;
    if (!followed) return 2;
    if (!wallet.address || shielded.status !== "ready" || !shielded.paymentAddress) return 3;
    return 4;
  }, [info, claimed, followed, wallet.address, shielded.status, shielded.paymentAddress]);

  const submit = useCallback(async () => {
    if (!info?.xid || !wallet.address || !shielded.paymentAddress) return;
    setBusy(true);
    setError(null);
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: claimMessage(info.xid, wallet.address, shielded.paymentAddress, issuedAt),
      });
      const res = await fetch(`${apiBase()}/api/claim`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.address, zcowl: shielded.paymentAddress, signature, issuedAt }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "try again");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [info, wallet.address, shielded.paymentAddress, signMessageAsync, refresh]);

  // Sent as a link the browser follows, not a fetch: X's consent screen is a
  // full page. The return origin rides along so the round trip lands back on
  // the host the user actually typed, keeping page and cookie on one site.
  const signIn = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const url = new URL(`${apiBase()}/auth/x/login`);
    url.searchParams.set("return", window.location.origin);
    window.location.assign(url.toString());
  }, []);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await shielded.unlock();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [shielded]);

  const xHandle = info?.xHandle ?? "cowlprotocol";

  // Each step carries what to say before it's done, and what it became once
  // it is — the card should read like a receipt as you move down it.
  const STEPS = [
    {
      k: "Sign in with X",
      d: "One account, one claim. We read your handle and nothing else",
      done: info?.signedIn ? `Signed in as @${info.handle}` : null,
    },
    {
      k: `Follow @${xHandle}`,
      d: "Where every batch is announced first",
      done: followed || claimed ? `Following @${xHandle}` : null,
    },
    {
      k: "Open your shielded address",
      d: "Connect a wallet and sign once — the address only you can read into",
      done:
        wallet.address && shielded.paymentAddress
          ? `${shortAddr(wallet.address)} → ${shielded.paymentAddress.slice(0, 16)}…`
          : wallet.address
            ? `${shortAddr(wallet.address)} connected — one sign to open`
            : null,
    },
    {
      k: "Claim",
      d: "One signature. The COWL lands shielded, off the tape",
      done: claimed ? (claimed.status === "sent" ? "Delivered" : "Queued for delivery") : null,
    },
  ];

  return (
    <div className="w-full max-w-[460px] mx-auto">
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <span className="label-mono text-[0.72rem] text-bone">Airdrop</span>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="A fixed batch of COWL, first come first served, one claim per X account. Delivery is a private send: the chain shows a distribution happened, never who claimed or how much."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              {LIVE ? "Batch one" : "Coming soon"}
            </span>
          </span>
        </div>

        {/* The batch, in numbers */}
        <div className="grid grid-cols-2 gap-1 my-1">
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Per claim</p>
            <p className="font-data text-xl text-acid tracking-tight">
              {LIVE && info ? `${info.amount} COWL` : "—"}
            </p>
          </div>
          <div className="bg-ink2 p-3.5">
            <p className="label-soft text-faint mb-1.5">Claimed</p>
            <p className="font-data text-xl text-bone tracking-tight">
              {LIVE && info ? `${info.claimed} / ${info.quota}` : "—"}
            </p>
          </div>
        </div>

        {/* The claim service is the card's source of truth — say so when it's gone. */}
        {LIVE && apiDown && (
          <div className="bg-ink2 p-3.5 my-1 flex items-center justify-between gap-3">
            <p className="text-xs text-[#c96a5a]">Can&apos;t reach the claim service.</p>
            <button
              onClick={refresh}
              className="label-mono text-[0.68rem] text-acid hover:text-bone transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Steps — each row turns into a receipt of what it became. */}
        <div className="mt-4 px-1 space-y-4">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const done = LIVE && (step > n || Boolean(claimed));
            const active = LIVE && step === n && !claimed;
            return (
              <div key={s.k} className={`flex gap-3 ${active || s.done ? "" : "opacity-70"}`}>
                <span
                  className={`shrink-0 h-6 w-6 flex items-center justify-center label-mono text-[0.62rem] ${
                    done ? "bg-[#161a10] text-acid" : active ? "bg-ink3 text-acid" : "bg-ink3 text-faint"
                  }`}
                >
                  {done ? "✓" : n}
                </span>
                <div className="flex-1">
                  <p className="label-soft text-bone">{s.k}</p>
                  {s.done ? (
                    <p className="text-xs text-acid mt-0.5 font-data break-all">{s.done}</p>
                  ) : (
                    <p className="text-xs text-muted mt-0.5">{s.d}</p>
                  )}
                  {active && n === 2 && (
                    <a
                      href={`https://x.com/intent/follow?screen_name=${xHandle}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setFollowed(true)}
                      className="inline-block mt-2 label-mono text-[0.68rem] text-acid hover:text-bone transition-colors"
                    >
                      Follow on X →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {LIVE && info?.signedIn && info.accountOk === false && (
          <p className="text-xs text-[#c96a5a] mt-4 px-1">This X account isn&apos;t eligible for batch one.</p>
        )}
        {error && <p className="text-xs text-[#c96a5a] mt-2 px-1">{error}</p>}

        {/* Action */}
        <div className="mt-4">
          {!LIVE ? (
            <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
              Batch one coming soon
            </button>
          ) : claimed ? (
            <div className="w-full label-mono text-sm py-4 bg-[#161a10] text-acid text-center">
              {claimed.status === "sent" ? "Delivered, unseen" : "Claimed — on its way, unseen"}
            </div>
          ) : info && !info.open ? (
            <button disabled className="w-full label-mono text-sm py-4 bg-ink3 text-faint cursor-default">
              Batch one is fully claimed
            </button>
          ) : step === 1 ? (
            // A real link, so sign-in still works if the page never hydrates;
            // the click handler only upgrades it with the return origin.
            <a
              href={`${CONFIGURED_API}/auth/x/login`}
              onClick={signIn}
              className="block w-full label-mono text-sm py-4 bg-acid text-ink text-center hover:opacity-90 transition-opacity"
            >
              Sign in with X
            </a>
          ) : step === 2 ? (
            <button
              onClick={() => setFollowed(true)}
              className="w-full label-mono text-sm py-4 bg-ink3 text-bone hover:text-acid transition-colors"
            >
              I follow @{xHandle}
            </button>
          ) : step === 3 ? (
            !wallet.address ? (
              <button
                onClick={wallet.connect}
                className="w-full label-mono text-sm py-4 bg-acid text-ink hover:opacity-90 transition-opacity"
              >
                Connect wallet
              </button>
            ) : (
              <button
                onClick={unlock}
                disabled={busy}
                className="w-full label-mono text-sm py-4 bg-acid text-ink hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {busy ? "Opening…" : "Open shielded address"}
              </button>
            )
          ) : (
            <button
              onClick={submit}
              disabled={busy || info?.accountOk === false}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy ? "Claiming…" : "Claim"}
            </button>
          )}
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        <MaskLogo className="inline h-2 w-auto text-acid mr-1.5" />
        On the tape it reads as a distribution. Who claimed, and how much — that stays yours.
      </p>
    </div>
  );
}
