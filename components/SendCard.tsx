"use client";

// Paying and being paid inside the pool.
//
// Nothing here touches the public chain the way the boundary does: a send
// spends notes and mints notes, so there is no address to type, no amount on
// the tape and no denomination plan to make one crossing look like another.
// What a sender needs is the recipient's zcowl address, and what a recipient
// needs is to hand that address out. The two tabs are exactly those halves.
//
// Each half is its own route (/send, /receive) and the tabs are links, so the
// tab you are on always has an address you can hand to someone. Being paid is
// the half people share.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatUnits, parseUnits } from "viem";
import { decodePaymentAddress, isPaymentAddress } from "@/lib/shielded/keys";
import { formatBalanceShort, formatUnitsExact } from "@/lib/prices";
import { useAssets, useShieldedAssets } from "@/lib/assets";
import { ensureTokenMeta } from "@/lib/tokenMeta";
import { TOKENS, tokenMetaForField } from "@/lib/tokens";
import type { useWallet } from "@/lib/useWallet";
import { useShielded, type OpProgress } from "./ShieldedProvider";
import SendConfirmModal from "./SendConfirmModal";
import TokenModal, { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";
import QrCode from "./QrCode";
import Spinner from "./Spinner";

type WalletState = ReturnType<typeof useWallet>;
export type Tab = "send" | "receive";

const TABS: { key: Tab; label: string; href: string }[] = [
  { key: "send", label: "Send", href: "/send" },
  { key: "receive", label: "Receive", href: "/receive" },
];

/** A token as the shielded book knows it: a pool field, named where possible. */
type ShieldedToken = { field: bigint; symbol: string; decimals: number; logoURI?: string };

function logoFor(field: bigint): string | undefined {
  if (field === 0n) return TOKENS.find((t) => t.native)?.logoURI;
  return TOKENS.find((t) => !t.native && !/^0x0{40}$/i.test(t.address) && BigInt(t.address) === field)?.logoURI;
}

export default function SendCard({ wallet, tab }: { wallet: WalletState; tab: Tab }) {
  const shielded = useShielded();
  const [selected, setSelected] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [merging, setMerging] = useState(false);

  /**
   * The recipient field grows to fit what is in it.
   *
   * A zcowl address is 116 characters and wraps to three lines at this width;
   * a fixed two-row box hid the front of it behind a scroll, so the part that
   * identifies the account was the part you could not see. Height is reset to
   * auto before measuring, or the box only ever grows and never shrinks back
   * when the field is cleared.
   */
  const toRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = toRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [to, tab]);
  const [copied, setCopied] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Bumped when the chain names a token the book was showing as a bare address.
  const [metaVersion, setMetaVersion] = useState(0);

  const unlocked = shielded.status === "ready";

  // The public book, borrowed only to name and price what the shielded one
  // holds, the same way the portfolio does it.
  const { assets: publicAssets } = useAssets(wallet.address as `0x${string}` | null);
  const { assets: shieldedAssets, loading: shieldedLoading } = useShieldedAssets(
    unlocked ? shielded.balances : [],
    publicAssets,
  );

  // Anyone can be paid in any ERC-20, so the book has to name tokens this app
  // has never been told about before it can offer them.
  useEffect(() => {
    let alive = true;
    ensureTokenMeta(shielded.balances.map((b) => b.token)).then((learned) => {
      if (alive && learned) setMetaVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [shielded.balances]);

  const tokens: ShieldedToken[] = useMemo(() => {
    void metaVersion; // names resolved since the last render
    return shielded.balances.map((b) => {
      const meta = tokenMetaForField(b.token);
      return { field: b.token, symbol: meta.symbol, decimals: meta.decimals, logoURI: logoFor(b.token) };
    });
  }, [shielded.balances, metaVersion]);

  // Follow the book: hold the pick while it is still spendable, otherwise take
  // whatever the account actually holds.
  useEffect(() => {
    if (tokens.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((cur) => (cur !== null && tokens.some((t) => t.field === cur) ? cur : tokens[0]!.field));
  }, [tokens]);

  const token = unlocked ? tokens.find((t) => t.field === selected) ?? null : null;
  const decimals = token?.decimals ?? 18;
  // The card keeps its shape before there is a book to read, so the native
  // token stands in for the glyph. It names nothing about what anyone holds.
  const nativeMeta = tokenMetaForField(0n);
  const displayToken: ShieldedToken =
    token ?? { field: 0n, symbol: nativeMeta.symbol, decimals: nativeMeta.decimals, logoURI: logoFor(0n) };

  const value = useMemo(() => {
    try {
      return parseUnits(amount || "0", decimals);
    } catch {
      return 0n;
    }
  }, [amount, decimals]);

  const balance = token ? shielded.balanceOf(token.field) : 0n;
  const sendable = token ? shielded.sendableOf(token.field) : 0n;

  const trimmedTo = to.trim();
  const validTo = isPaymentAddress(trimmedTo);
  // A self-payment by keys, not by string: the legacy hex form of your own
  // address is still you.
  const toSelf = useMemo(() => {
    if (!validTo || !shielded.paymentAddress) return false;
    try {
      return decodePaymentAddress(trimmedTo).mpk === decodePaymentAddress(shielded.paymentAddress).mpk;
    } catch {
      return false;
    }
  }, [validTo, trimmedTo, shielded.paymentAddress]);
  const overBalance = value > balance;
  // A join-split reads two notes at most, so a book can hold more than one
  // transfer can carry. Say which number applies rather than failing at proving.
  const overSendable = !overBalance && value > sendable;

  const ready = unlocked && !!token && value > 0n && validTo && !overBalance && !overSendable;

  let label = "Enter an amount";
  if (unlocked && tokens.length === 0) label = "Shield something first";
  if (value > 0n) label = "Review send";
  if (value > 0n && !trimmedTo) label = "Enter a payment address";
  if (trimmedTo && !validTo) label = "That is not a zcowl address";
  if (overBalance && token) label = `Insufficient shielded ${token.symbol}`;
  if (overSendable && token) {
    label = `Merge notes to send ${formatUnitsExact(value, decimals)} ${token.symbol}`;
  }

  const unlock = async () => {
    setUnlockError(null);
    try {
      await shielded.unlock();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUnlockError(/rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0] ?? msg);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the address is on screen to copy manually */
    }
  };

  /**
   * The cap is not a wall, it is a shape the book is in: two notes at a time.
   * Merging fixes it, so the button that reports the cap is the button that
   * clears it. Announcing a limit with no way past it is the same dead end the
   * unlock row used to be.
   */
  const merge = () => {
    if (!token) return;
    shielded.clearProgress();
    setMerging(true);
    shielded
      .consolidateExec({ tokenField: token.field, symbol: token.symbol, decimals, target: value })
      .catch(() => {});
  };

  const execute = () => {
    if (!token) return;
    shielded.clearProgress();
    shielded
      .sendExec({ to: trimmedTo, value, tokenField: token.field, symbol: token.symbol, decimals })
      .catch(() => {});
  };

  const closeConfirm = () => {
    setConfirming(false);
    if (shielded.progress?.done) {
      setAmount("");
      setTo("");
    }
    shielded.clearProgress();
  };

  return (
    <div className="w-full max-w-[460px] mx-auto">
      <div className="bg-card p-4 md:p-5 fade-up">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            {TABS.map((t) =>
              t.key === tab ? (
                <span
                  key={t.key}
                  className="label-mono text-[0.72rem] text-bone border-b border-acid pb-0.5"
                >
                  {t.label}
                </span>
              ) : (
                <Link
                  key={t.key}
                  href={t.href}
                  className="label-mono text-[0.72rem] text-faint hover:text-muted transition-colors"
                >
                  {t.label}
                </Link>
              ),
            )}
          </div>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="A payment between shielded accounts never becomes public. The chain logs that a spend happened. Not the asset, not the amount, not either end."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">
              Fully private
            </span>
          </span>
        </div>

        {!unlocked ? (
          <LockedPanel
            wallet={wallet}
            status={shielded.status}
            error={unlockError}
            onUnlock={unlock}
            tab={tab}
          />
        ) : tab === "send" ? (
          <>
            {/* Amount */}
            <div className="bg-ink2 p-4 my-1">
              <div className="flex items-center justify-between mb-2 gap-3">
                <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
                  <MaskLogo className="h-2 w-auto text-acid" />
                  Shielded balance
                </span>
                <span className="flex items-center gap-2 text-[0.7rem] text-faint font-data whitespace-nowrap">
                  {token ? (
                    <>
                      <span title={`${formatUnitsExact(balance, decimals)} ${token.symbol}`}>
                        {formatBalanceShort(balance, decimals)} {token.symbol}
                      </span>
                      {balance > 0n && (
                        <button
                          // MAX is the whole balance, not the slice that happens
                          // to fit in two notes today. Merging can reach the rest,
                          // and the button below offers exactly that, so capping
                          // MAX here would hide money the account really holds.
                          //
                          // The field parses what it is given, so this writes a
                          // plain decimal, never the grouped display form.
                          onClick={() => setAmount(formatUnits(balance, decimals))}
                          className="text-acid hover:text-acid2 font-data text-[0.65rem]"
                        >
                          MAX
                        </button>
                      )}
                    </>
                  ) : (
                    <span>nothing shielded yet</span>
                  )}
                  {shielded.syncing && <Spinner className="h-3 w-3 text-acid" />}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  className="amount text-3xl md:text-4xl text-bone placeholder:text-faint outline-none font-data tracking-tight"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  disabled={!token}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                />
                {/* The same picker the boundary uses. A row of chips ran out of
                    width the moment a book held more than a few assets, and it
                    could not show a balance or a name beside the ticker. */}
                <button
                  onClick={() => tokens.length > 0 && setPicking(true)}
                  disabled={tokens.length === 0}
                  className="shrink-0 flex items-center gap-2 bg-ink3 pl-2 pr-3 py-2 hover:bg-ink transition-colors disabled:hover:bg-ink3"
                >
                  <TokenGlyph symbol={displayToken.symbol} src={displayToken.logoURI} />
                  <span className="label-mono text-[0.78rem] text-bone">{displayToken.symbol}</span>
                  {tokens.length > 1 && <span className="text-faint text-[0.6rem] leading-none">▾</span>}
                </button>
              </div>
            </div>

            {/* Recipient */}
            <div className="bg-ink2 p-4 my-1">
              <div className="flex items-center justify-between mb-2 gap-3">
                <span className="label-soft text-faint whitespace-nowrap">To</span>
                {validTo && (
                  <span className="label-soft text-acid whitespace-nowrap">
                    {toSelf ? "Your own address" : "Valid address"}
                  </span>
                )}
              </div>
              <textarea
                ref={toRef}
                className="w-full bg-transparent text-bone placeholder:text-faint outline-none font-data text-sm resize-none overflow-hidden leading-relaxed break-all disabled:text-faint"
                rows={1}
                spellCheck={false}
                placeholder="zcowl1…"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>

            {overSendable && token && (
              <p className="text-[0.7rem] text-faint leading-relaxed mt-3">
                One spend reads two notes, and your two largest come to{" "}
                {formatUnitsExact(sendable, decimals)} {token.symbol}. Merging combines them into
                bigger notes, back to yourself, until this amount fits in two.
              </p>
            )}

            {/* What this costs, and what it shows */}
            {value > 0n && (
              <div className="mt-3 px-1 space-y-2 fade-up">
                <Row k="On chain" v="two nullifiers, two commitments" />
                <Row k="Amount" v="never becomes public" accent />
                <Row k="Proving" v="In your browser" accent />
                <Row k="Wallet confirmations" v="1" />
                <Row k="Gas payer" v="You" />
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
              ) : overSendable && token ? (
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
            </div>
          </>
        ) : (
          <ReceivePanel copied={copied} onCopy={copy} />
        )}
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-faint mt-4">
        {tab === "receive"
          ? "Whoever pays it learns nothing about you."
          : "A note changes hands. The chain sees a spend, never the two ends of it."}
      </p>

      {/* The picker offers the shielded book and nothing else: a token with no
          note behind it is not something anyone can send. */}
      <TokenModal
        open={picking}
        assets={shieldedAssets}
        assetsLoading={shieldedLoading}
        emptyNote={
          unlocked
            ? "Nothing shielded yet. Shield something first and you can pay with it."
            : "Unlock your shielded account to see what you can send."
        }
        onClose={() => setPicking(false)}
        onSelect={(t) => {
          setSelected(t.native ? 0n : BigInt(t.address));
          setAmount("");
        }}
      />

      {token && (
        <SendConfirmModal
          open={confirming}
          symbol={token.symbol}
          logoURI={token.logoURI}
          amount={amount}
          to={trimmedTo}
          toSelf={toSelf}
          progress={shielded.progress}
          onExecute={execute}
          onClose={closeConfirm}
        />
      )}

      {/* Merging is a run of real transactions, one per round. Without a panel
          of its own the wallet popped up over a card that looked idle. */}
      {token && merging && (
        <MergeProgressModal
          symbol={token.symbol}
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

/** Everything on this card needs the view key, so both tabs share one gate. */
function LockedPanel({
  wallet,
  status,
  error,
  onUnlock,
  tab,
}: {
  wallet: WalletState;
  status: string;
  error: string | null;
  onUnlock: () => void;
  tab: Tab;
}) {
  return (
    <div className="bg-ink2 p-5 my-1">
      <p className="text-xs text-muted leading-relaxed">
        {tab === "send"
          ? "One wallet signature derives your shielded keys. They live in this tab, sign the spend, and go nowhere else."
          : "Your payment address is built from your shielded keys, and one wallet signature is what builds them. It happens here, in this tab."}
      </p>
      <div className="mt-4">
        {wallet.address ? (
          <button
            onClick={onUnlock}
            disabled={status === "unlocking"}
            className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
          >
            {status === "unlocking" ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner className="h-3 w-3" />
                Check your wallet
              </span>
            ) : (
              "Unlock shielded account"
            )}
          </button>
        ) : (
          <button
            onClick={wallet.connect}
            disabled={wallet.connecting}
            className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
          >
            {wallet.connecting ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner className="h-3 w-3" />
                Connecting
              </span>
            ) : (
              "Connect wallet"
            )}
          </button>
        )}
        {error && <p className="text-xs text-[#ff6b6b] mt-2 text-center">{error}</p>}
      </div>
    </div>
  );
}

function ReceivePanel({ copied, onCopy }: { copied: boolean; onCopy: (text: string) => void }) {
  const shielded = useShielded();
  const address = shielded.paymentAddress;

  return (
    <>
      <div className="bg-ink2 p-4 my-1">
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
            <MaskLogo className="h-2 w-auto text-acid" />
            Your payment address
          </span>
          {address && (
            <button onClick={() => onCopy(address)} className="label-soft text-muted hover:text-bone shrink-0">
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        <code className={`block font-data text-[0.72rem] break-all leading-relaxed ${address ? "text-bone" : "text-faint"}`}>
          {address ?? "zcowl1…"}
        </code>
      </div>

      {/* A hundred and sixteen characters is not something anyone reads aloud
          or retypes, so the address is handed over by camera instead. */}
      {address && (
        <div className="bg-ink2 p-4 my-1 flex flex-col items-center gap-3">
          <QrCode text={address} />
          <span className="label-soft text-faint text-center">Scan to pay this address</span>
        </div>
      )}

      <div className="mt-3 px-1 space-y-2">
        <Row k="Reusable" v="never needs rotating" />
        <Row k="Your wallet" v="never appears in it" accent />
        <Row k="Senders" v="this app and the cowl CLI both pay it" />
      </div>

      {address ? (
        <div className="bg-ink2 p-4 mt-3">
          <div className="flex items-center justify-between mb-2 gap-3">
            <span className="label-soft text-faint">What has arrived</span>
            <button onClick={() => shielded.refresh()} className="label-soft text-muted hover:text-bone">
              {shielded.syncing ? (
                <span className="flex items-center gap-1.5">
                  <Spinner className="h-3 w-3" />
                  Scanning
                </span>
              ) : (
                "Scan for payments"
              )}
            </button>
          </div>
          {shielded.balances.length === 0 ? (
            <p className="text-xs text-muted leading-relaxed">
              Nothing yet. Payments show up here as soon as the sender&apos;s transaction lands.
            </p>
          ) : (
            <div className="space-y-1">
              {shielded.balances.map((b) => {
                const meta = tokenMetaForField(b.token);
                return (
                  <div key={b.token.toString()} className="flex items-center justify-between bg-ink px-3 py-2.5">
                    <span className="text-sm text-bone">{meta.symbol}</span>
                    <span className="font-data text-sm text-acid">
                      {formatUnitsExact(b.amount, meta.decimals)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </>
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

/**
 * The live view of a merge run.
 *
 * Merging is not a payment, so it borrows nothing from the send modal: no
 * recipient, no amount leaving. What it needs to show is that transactions are
 * going out, how many are left, and that the wallet is about to ask.
 */
function MergeProgressModal({
  symbol,
  progress,
  onClose,
}: {
  symbol: string;
  progress: OpProgress | null;
  onClose: () => void;
}) {
  const running = !!progress && !progress.done && !progress.error;
  const total = progress?.parts.length ?? 0;
  const landed = progress?.txs.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/70"
      onClick={running ? undefined : onClose}
    >
      <div className="w-full max-w-sm bg-card fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="label-mono text-[0.72rem] text-bone">Merging notes</span>
          {!running && (
            <button onClick={onClose} className="text-faint hover:text-bone text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        <div className="px-5 pb-5 space-y-3">
          <p className="text-xs text-muted leading-relaxed">
            Each round combines your two smallest {symbol} notes into one, back to yourself. Nothing
            leaves your balance.
          </p>

          <div className="bg-ink2 px-4 py-3 flex items-center justify-between text-xs">
            <span className="text-faint font-data">Rounds</span>
            <span className="font-data text-acid">
              {landed} of {total || "…"}
            </span>
          </div>

          {running && (
            <p className="flex items-center gap-2 text-[0.7rem] text-muted leading-relaxed">
              <Spinner className="h-3 w-3" />
              {progress?.step === "confirm"
                ? "Confirm in your wallet"
                : progress?.step === "prove"
                  ? "Proving in your browser"
                  : progress?.step === "mined" || progress?.step === "record"
                    ? "Recording the round"
                    : "Reading the chain"}
            </p>
          )}
          {running && (
            <p className="text-[0.7rem] text-faint leading-relaxed">
              Stay here until the last round lands. Whatever already reached the chain is done.
            </p>
          )}
          {progress?.error && <p className="text-xs text-[#ff6b6b] leading-relaxed">{progress.error}</p>}
          {progress?.done && (
            <p className="text-xs text-muted leading-relaxed">
              Merged. The amount you were after fits in one spend now.
            </p>
          )}

          {!running && (
            <button
              onClick={onClose}
              className="w-full label-mono text-sm py-4 bg-acid text-ink hover:bg-acid2 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
