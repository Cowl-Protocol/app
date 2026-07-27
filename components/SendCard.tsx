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
import { formatBalanceShort, formatUnitsExact, usdOf } from "@/lib/prices";
import { useTokenPrice } from "@/lib/tokenPrice";
import { useRelayQuote, useSelfGasEstimate } from "@/lib/relay";
import { activeNetwork } from "@/lib/networks";
import { BETA_USD_CAP, overBetaCap } from "@/lib/betaLimits";
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

const net = activeNetwork();

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

  // Who pays the gas, asked before anything is signed rather than discovered
  // afterwards. The relayer's fee is drawn from these same notes, so it is part
  // of what the balance has to cover — and the screen has to say so while
  // someone can still change the amount.
  const { quote: relay, checking: relayChecking } = useRelayQuote(
    token ? token.field : null,
    tab === "send",
  );
  /**
   * The relayer is the default, not the only door. Self-paid submits from the
   * wallet — the CLI's --self — and zeroes the fee the notes must cover, which
   * for a balance below one fee is the difference between moving and not.
   */
  const [selfPay, setSelfPay] = useState(false);
  const gasless = !!relay && !selfPay;
  const relayFee = gasless && relay ? relay.fee : 0n;
  // What actually leaves the book: the payment plus that fee.
  const drawn = value + relayFee;
  // The other half of the choice, priced so "Gas payer: You" has a number too.
  const selfGas = useSelfGasEstimate(1, tab === "send" && !gasless && value > 0n);

  /**
   * The largest payment this book can actually deliver.
   *
   * Not the balance less one fee. A spend reads two notes, so paying out
   * everything means merging the rest down into them first, and every one of
   * those rounds pays a relayer too — n notes cost n − 2 rounds plus the send
   * itself. Subtracting a single fee writes a number that no amount of merging
   * ever reaches: the run spends its way through every round and still comes up
   * short, ending on "even merged, this balance cannot cover that amount" after
   * paying for the attempt.
   */
  const noteCount = token ? shielded.balances.find((b) => b.token === token.field)?.notes ?? 0 : 0;
  const feesToEmpty = BigInt(Math.max(noteCount - 1, 1)) * relayFee;
  const maxSendable = balance > feesToEmpty ? balance - feesToEmpty : 0n;

  /**
   * The fee buys one spend's gas whatever the payment is worth, so its share
   * shrinks as the amount grows. Worth naming, because in token terms a cheap
   * asset makes an ordinary fee look enormous — a fee of about a dollar reads
   * as thousands of COWL, and only the share says which of those it is.
   */
  const feeSharePct =
    relayFee > 0n && value > 0n ? Number((relayFee * 1000n) / value) / 10 : 0;
  const feeIsSteep = gasless && feeSharePct >= 10;

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
  // Measured against what the spend really draws, fee included: a payment of
  // the whole balance cannot also pay a relayer out of it, and finding that out
  // at proving time would be finding it out too late.
  const overBalance = drawn > balance;
  /**
   * Held, but not deliverable.
   *
   * Gathering a fragmented book into two notes costs a fee per round, and those
   * fees come out of the same balance — so a book can hold 250,000 and still
   * top out at 148,000 once the 23 rounds it would take are paid for. Without
   * this the amount reads as merely needing a merge, the button offers one, and
   * the run spends its way through every round before ending on "even merged,
   * this balance cannot cover that amount". Same number MAX writes, applied as
   * a limit rather than only as a suggestion.
   */
  const overReach = !overBalance && value > maxSendable;
  // A join-split reads two notes at most, so a book can hold more than one
  // transfer can carry. Say which number applies rather than failing at proving.
  const overSendable = !overBalance && !overReach && drawn > sendable;

  /**
   * Blocked by the fee, not by the payment.
   *
   * A relayer's fee comes out of these same notes, so a balance can cover the
   * amount typed and still refuse to move — the exact position every small
   * balance is in. Paying the gas from the wallet zeroes that fee, and the
   * offer to switch belongs on the screen that just said no.
   */
  const feeTrapped =
    !!relay && !selfPay && value > 0n && value <= balance && (overBalance || overReach);

  // The dollar figure the cap is measured in, and the one the confirm panel
  // shows.
  //
  // Pricing wants the full token record, which the shielded book does not carry
  // — it knows a field, a symbol and a decimal count, and nothing else. The
  // asset list built beside it does carry one, so match on the field and borrow
  // it rather than rebuilding an address from the field by hand.
  const priceToken = useMemo(() => {
    if (!token) return null;
    return (
      shieldedAssets.find((a) => (a.token.native ? 0n : BigInt(a.token.address)) === token.field)
        ?.token ?? null
    );
  }, [shieldedAssets, token]);
  const price = useTokenPrice(priceToken);
  const amt = parseFloat(amount) || 0;
  const usd = usdOf(amt, price);
  const overCap = overBetaCap(amt, price);

  const ready =
    unlocked && !!token && value > 0n && validTo && !overBalance && !overReach && !overSendable && !overCap;

  let label = "Enter an amount";
  if (unlocked && tokens.length === 0) label = "Shield something first";
  if (value > 0n) label = "Review send";
  if (value > 0n && !trimmedTo) label = "Enter a payment address";
  if (trimmedTo && !validTo) label = "That is not a zcowl address";
  // Below the balance checks on purpose: when both apply, the balance is the
  // one someone can act on, so it takes the button.
  if (overCap) label = `Beta caps a send at $${BETA_USD_CAP}`;
  if (overBalance && token) {
    label = feeTrapped
      ? "Not enough for the amount plus the relayer fee"
      : `Insufficient shielded ${token.symbol}`;
  }
  if (overReach && token) {
    label = `Fees to gather it cap this at ${formatBalanceShort(maxSendable, decimals)} ${token.symbol}`;
  }
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
      // The payment, not the draw: the run quotes the fee itself, per round, so
      // it merges against today's price rather than whatever this card last read.
      .consolidateExec({ tokenField: token.field, symbol: token.symbol, decimals, target: value, selfPay })
      .catch(() => {});
  };

  const execute = () => {
    if (!token) return;
    shielded.clearProgress();
    shielded
      .sendExec({ to: trimmedTo, value, tokenField: token.field, symbol: token.symbol, decimals, selfPay })
      .catch(() => {});
  };

  const closeConfirm = () => {
    setConfirming(false);
    if (shielded.progress?.done) {
      setAmount("");
      setTo("");
      // The choice was for that payment. The next one starts gasless again.
      setSelfPay(false);
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
              text="A payment between shielded accounts never becomes public. The chain logs that a spend happened. Not the amount, not either end."
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
                          //
                          // Less every fee getting there costs — the merge
                          // rounds as well as the send. See maxSendable.
                          onClick={() => setAmount(formatUnits(maxSendable, decimals))}
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
              {usd && <div className="mt-2 text-[0.7rem] text-faint font-data">{usd}</div>}
              {/* Stated before someone hits it, not after. A ceiling you only
                  meet by bouncing off it reads as a fault; one you can see
                  reads as a decision. The second line answers the question a
                  limit always raises, which is whether the way out has one too.

                  It keeps its block in both states so nothing shifts under the
                  cursor when the limit is crossed; only the colour moves. */}
              <p
                className={`mt-3 px-3 py-2 text-[0.7rem] leading-relaxed transition-colors ${
                  overCap ? "bg-warn/10 text-warn" : "bg-ink3 text-faint"
                }`}
              >
                Beta caps a send at ${BETA_USD_CAP}. Withdrawals are not capped, so whatever you
                hold comes back out on your say so.
              </p>
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
                <Row
                  k="Wallet confirmations"
                  v={relayChecking ? "…" : gasless ? "0" : "1"}
                  accent={gasless}
                />
                {/* A choice, not a verdict, whenever a relayer is standing by.
                    Relayed keeps this wallet off the chain entirely; self-paid
                    zeroes the fee the notes must cover. Both are real, so both
                    are offered — the same pair the CLI spells with --self. */}
                <div className="flex items-center justify-between text-xs gap-4">
                  <span className="flex items-center gap-1.5 text-faint font-data shrink-0">
                    Gas payer
                    {relay && !relayChecking && (
                      <InfoTip text="The relayer submits the spend, so your wallet never appears on chain, and its fee comes out of the notes you are spending. Pay the gas yourself and no fee leaves the notes — your wallet submits instead, and shows as the caller." />
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
                            selfPay === self
                              ? "bg-acid text-ink"
                              : "bg-ink2 text-muted hover:text-bone"
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
                {!gasless && !relayChecking && (
                  <p className="text-[0.7rem] text-faint leading-relaxed pt-1">
                    Your wallet submits this spend and pays its gas, so it shows on chain as the
                    caller. Nothing is drawn from your notes but the payment itself, and the amount
                    and the recipient stay hidden either way.
                  </p>
                )}
                {gasless && token && (
                  <>
                    <Row k="Relayer fee" v={`${formatBalanceShort(relayFee, decimals)} ${token.symbol}`} />
                    <Row
                      k="Drawn from your balance"
                      v={`${formatBalanceShort(drawn, decimals)} ${token.symbol}`}
                      accent
                    />
                    {/* Not a blocker. The payment is perfectly valid, it is just
                        a bad trade at this size, and only the person making it
                        can decide whether that matters. */}
                    {feeIsSteep && (
                      <p className="text-[0.7rem] text-warn leading-relaxed pt-1">
                        That fee is {feeSharePct.toFixed(0)}% of what you are sending. It costs one
                        spend&apos;s gas whatever the size, so a larger payment pays the same fee and
                        a smaller share of it.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* The way past the fee, on the screen that named it. A balance the
                fee has trapped is exactly the balance the switch was built for,
                so the button that says "not enough" gets a neighbour that fixes
                it rather than a dead end. */}
            {feeTrapped && (
              <div className="mt-3 px-3 py-2 bg-ink3 fade-up">
                <p className="text-[0.7rem] text-faint leading-relaxed">
                  It is the relayer&apos;s fee this balance cannot cover — the payment itself fits.
                  Pay the gas from your wallet and nothing is drawn from the notes but the payment.
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
          // A different token is a different fee question — back to the default.
          setSelfPay(false);
        }}
      />

      {token && (
        <SendConfirmModal
          open={confirming}
          symbol={token.symbol}
          logoURI={token.logoURI}
          amount={amount}
          usd={usd}
          to={trimmedTo}
          toSelf={toSelf}
          gasless={gasless}
          relayFee={gasless ? `${formatBalanceShort(relayFee, decimals)} ${token.symbol}` : undefined}
          drawn={gasless ? `${formatBalanceShort(drawn, decimals)} ${token.symbol}` : undefined}
          networkFee={
            !gasless && selfGas !== null
              ? `~${formatBalanceShort(selfGas, 18)} ${net.currency.symbol}`
              : undefined
          }
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
        <Row k="Senders" v="any cowl client pays it" />
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
            Each round combines your two largest {symbol} notes into one, back to yourself, lifting
            what a single payment can carry.
          </p>
          {progress &&
            (progress.relayed ? (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                The relayer submits each round and pays the gas, so none of this reaches the chain
                from your wallet. Its fee comes out of the notes being merged, one per round.
              </p>
            ) : (
              <p className="text-[0.7rem] text-faint leading-relaxed">
                Your wallet submits each round and pays its gas — expect one confirmation per round.
                No fee leaves the notes being merged.
              </p>
            ))}

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
                ? progress.relayed
                  ? "The relayer is submitting"
                  : "Confirm in your wallet"
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
