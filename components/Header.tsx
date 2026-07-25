"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ConnectButton from "./ConnectButton";
import Logo from "./Logo";
import NetworkSelect from "./NetworkSelect";
import type { useWallet } from "@/lib/useWallet";

type WalletState = ReturnType<typeof useWallet>;

const LINKS = [
  { href: "/", label: "Swap", soon: true },
  { href: "/shield", label: "Shield" },
  { href: "/send", label: "Send", soon: true },
  { href: "/receive", label: "Receive", soon: true },
  { href: "/portfolio", label: "Portfolio" },
];

const DOCS = "https://cowlprotocol.com/docs";

export default function Header({ wallet }: { wallet: WalletState }) {
  const pathname = usePathname();

  return (
    <header className="w-full px-4 md:px-10 py-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-4 md:gap-8 min-w-0">
        <a href="https://cowlprotocol.com" className="flex items-center gap-2.5 select-none shrink-0">
          <Logo className="h-7 w-auto text-acid" />
          <span className="display text-[1.35rem] leading-none hidden sm:inline">Cowl</span>
        </a>

        {/* Wide screens carry every destination at once. */}
        <nav className="hidden xl:flex items-center gap-6">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <span key={l.href} className="relative">
                {active ? (
                  <span className="label-mono text-[0.72rem] text-bone border-b border-acid pb-0.5">
                    {l.label}
                  </span>
                ) : (
                  <Link
                    href={l.href}
                    className="label-mono text-[0.72rem] text-muted hover:text-bone transition-colors"
                  >
                    {l.label}
                  </Link>
                )}
                {l.soon && <SoonTag />}
              </span>
            );
          })}
          <a
            href={DOCS}
            className="label-mono text-[0.72rem] text-muted hover:text-bone transition-colors"
          >
            Docs
          </a>
        </nav>

        {/* Narrower than that, the same destinations fold into one control so
            they can never run under the wallet button. */}
        <div className="xl:hidden">
          <NavMenu pathname={pathname} />
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden sm:block">
          <NetworkSelect />
        </div>
        <ConnectButton
          address={wallet.address}
          connecting={wallet.connecting}
          hasWallet={wallet.hasWallet}
          wrongNetwork={wallet.wrongNetwork}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
          onSwitch={wallet.switchNetwork}
        />
      </div>
    </header>
  );
}

/** The nav as a dropdown: the trigger says where you are, the panel where you can go. */
function NavMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // A tap that lands on the page you are already on still closes the panel.
  useEffect(() => setOpen(false), [pathname]);

  const current = LINKS.find((l) => l.href === pathname);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 label-mono text-[0.72rem] text-bone px-3.5 py-2.5 bg-[#1c2027] hover:bg-[#242932] transition-colors"
      >
        {current?.label ?? "Menu"}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="absolute left-0 top-11 z-30 w-56 bg-card fade-up">
          {LINKS.map((l) => {
            const active = l.href === pathname;
            return (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="flex items-center px-4 py-3 transition-colors hover:bg-ink3"
              >
                <span className="relative">
                  <span className={`label-mono text-[0.72rem] ${active ? "text-acid" : "text-bone"}`}>
                    {l.label}
                  </span>
                  {l.soon && <SoonTag />}
                </span>
              </Link>
            );
          })}
          <a
            href={DOCS}
            onClick={() => setOpen(false)}
            className="flex items-center px-4 py-3 label-mono text-[0.72rem] text-muted hover:text-bone hover:bg-ink3 transition-colors"
          >
            Docs ↗
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Hangs off the top-right corner of the label it marks, out of the flow — a
 * gated destination reads the same width as a live one, so adding or opening
 * one never re-spaces the nav.
 */
function SoonTag() {
  return (
    <span className="absolute -top-2 -right-2.5 label-soft text-[0.48rem] text-faint bg-ink2 px-1 py-0.5 leading-none pointer-events-none">
      Soon
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-bone transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
