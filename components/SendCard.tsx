"use client";

// Paying and being paid inside the pool.
//
// Nothing here touches the public chain the way the boundary does: a send
// spends notes and mints notes, so there is no address to type, no amount on
// the tape and no denomination plan to make one crossing look like another.
// What a sender needs is the recipient's zcowl address, and what a recipient
// needs is to hand that address out. The two tabs are exactly those halves.
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { isPaymentAddress } from "@/lib/shielded/keys";
import { formatUnitsExact } from "@/lib/prices";
import { ensureTokenMeta } from "@/lib/tokenMeta";
import { TOKENS, tokenMetaForField } from "@/lib/tokens";
import type { useWallet } from "@/lib/useWallet";
import { useShielded } from "./ShieldedProvider";
import SendConfirmModal from "./SendConfirmModal";
import { TokenGlyph } from "./TokenModal";
import MaskLogo from "./MaskLogo";
import InfoTip from "./InfoTip";

type WalletState = ReturnType<typeof useWallet>;
type Tab = "send" | "receive";

/** A token as the shielded book knows it: a pool field, named where possible. */
type ShieldedToken = { field: bigint; symbol: string; decimals: number; logoURI?: string };

function logoFor(field: bigint): string | undefined {
  if (field === 0n) return TOKENS.find((t) => t.native)?.logoURI;
  return TOKENS.find((t) => !t.native && !/^0x0{40}$/i.test(t.address) && BigInt(t.address) === field)?.logoURI;
}

export default function SendCard({ wallet }: { wallet: WalletState }) {
  const shielded = useShielded();
  const [tab, setTab] = useState<Tab>("send");
  const [selected, setSelected] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Bumped when the chain names a token the book was showing as a bare address.
  const [metaVersion, setMetaVersion] = useState(0);

  const unlocked = shielded.status === "ready";

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

  const token = tokens.find((t) => t.field === selected) ?? null;
  const decimals = token?.decimals ?? 18;

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
  const toSelf = validTo && !!shielded.paymentAddress && trimmedTo === shielded.paymentAddress;
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
  if (overSendable && token) label = `One send moves up to ${formatUnitsExact(sendable, decimals)} ${token.symbol}`;

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
            {(["send", "receive"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`label-mono text-[0.72rem] transition-colors ${
                  tab === t ? "text-bone border-b border-acid pb-0.5" : "text-faint hover:text-muted"
                }`}
              >
                {t === "send" ? "Send" : "Receive"}
              </button>
            ))}
          </div>
          <span className="flex items-center gap-2">
            <InfoTip
              align="right"
              text="Payments between shielded accounts never leave the pool. The chain records that a spend happened, not the asset, the amount or who was on either end."
            />
            <span className="label-mono text-[0.62rem] text-acid px-2 py-1 bg-[#161a10]">Inside the pool</span>
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
                      <span>
                        {formatUnitsExact(balance, decimals)} {token.symbol}
                      </span>
                      {sendable > 0n && (
                        <button
                          // The field parses what it is given, so MAX writes a
                          // plain decimal, never the grouped display form.
                          onClick={() => setAmount(formatUnits(sendable, decimals))}
                          className="text-acid hover:text-acid2 font-data text-[0.65rem]"
                        >
                          MAX
                        </button>
                      )}
                    </>
                  ) : (
                    <span>nothing shielded yet</span>
                  )}
                  {shielded.syncing && (
                    <span className="inline-block h-2 w-2 border-2 border-acid border-t-transparent rounded-full spin" />
                  )}
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
                {token && (
                  <span className="shrink-0 flex items-center gap-2 bg-ink3 pl-2 pr-3 py-2">
                    <TokenGlyph symbol={token.symbol} src={token.logoURI} />
                    <span className="label-mono text-[0.78rem] text-bone">{token.symbol}</span>
                  </span>
                )}
              </div>
              {tokens.length > 1 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {tokens.map((t) => (
                    <button
                      key={t.field.toString()}
                      onClick={() => {
                        setSelected(t.field);
                        setAmount("");
                      }}
                      className={`px-2.5 py-1 text-xs font-data transition-colors ${
                        t.field === selected ? "bg-acid text-ink" : "bg-ink3 text-muted hover:text-bone"
                      }`}
                    >
                      {t.symbol}
                    </button>
                  ))}
                </div>
              )}
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
                className="w-full bg-transparent text-bone placeholder:text-faint outline-none font-data text-sm resize-none leading-relaxed break-all"
                rows={2}
                spellCheck={false}
                placeholder="zcowl:0x…"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>

            {/* What this costs, and what it shows */}
            {value > 0n && (
              <div className="mt-3 px-1 space-y-2 fade-up">
                <Row k="On chain" v="two nullifiers, two commitments" />
                <Row k="Amount" v="stays inside the pool" accent />
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
                  {wallet.connecting ? "Connecting…" : wallet.hasWallet ? "Connect wallet" : "Get a wallet"}
                </button>
              ) : wallet.wrongNetwork ? (
                <button
                  onClick={wallet.switchNetwork}
                  className="w-full label-mono text-sm py-4 bg-[#3a1414] text-[#ff6b6b] hover:bg-[#4a1818] transition-colors"
                >
                  Switch to {wallet.network.label}
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

      <p className="text-center text-xs text-faint mt-4">
        {tab === "send"
          ? "A note changes hands. The chain sees a spend, never the two ends of it."
          : "One address, reusable, and it never names your wallet."}
      </p>

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
          ? "One wallet signature derives your shielded keys, in this tab only. They sign the spend and nothing else sees them."
          : "Your payment address comes from your shielded keys. One wallet signature derives them, in this tab only."}
      </p>
      <div className="mt-4">
        {wallet.address ? (
          <button
            onClick={onUnlock}
            disabled={status === "unlocking"}
            className="w-full label-mono text-xs py-3 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
          >
            {status === "unlocking" ? "Check your wallet…" : "Unlock shielded account"}
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
        {error && <p className="text-xs text-[#ff6b6b] mt-2 text-center">{error}</p>}
      </div>
    </div>
  );
}

function ReceivePanel({
  copied,
  onCopy,
}: {
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  const shielded = useShielded();
  const address = shielded.paymentAddress;
  if (!address) return null;

  return (
    <>
      <div className="bg-ink2 p-4 my-1">
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="flex items-center gap-1.5 label-soft text-faint whitespace-nowrap">
            <MaskLogo className="h-2 w-auto text-acid" />
            Your payment address
          </span>
          <button onClick={() => onCopy(address)} className="label-soft text-muted hover:text-bone shrink-0">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <code className="block font-data text-[0.72rem] text-bone break-all leading-relaxed">{address}</code>
      </div>

      <div className="mt-3 px-1 space-y-2">
        <Row k="Reusable" v="the same address, every payment" />
        <Row k="Your wallet" v="never appears in it" accent />
        <Row k="Senders" v="pay from this app or the terminal" />
      </div>

      <div className="bg-ink2 p-4 mt-3">
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="label-soft text-faint">What has arrived</span>
          <button onClick={() => shielded.refresh()} className="label-soft text-muted hover:text-bone">
            {shielded.syncing ? "Scanning…" : "Scan for payments"}
          </button>
        </div>
        {shielded.balances.length === 0 ? (
          <p className="text-xs text-muted leading-relaxed">
            Nothing yet. A payment lands here the moment its sender's transaction does.
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
