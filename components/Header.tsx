"use client";

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
  { href: "/portfolio", label: "Portfolio" },
];

export default function Header({ wallet }: { wallet: WalletState }) {
  const pathname = usePathname();

  return (
    <header className="w-full px-4 md:px-10 py-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-5 md:gap-8 min-w-0">
        <a href="https://cowlprotocol.com" className="flex items-center gap-2.5 select-none shrink-0">
          <Logo className="h-7 w-auto text-acid" />
          <span className="display text-[1.35rem] leading-none hidden sm:inline">Cowl</span>
        </a>
        <nav className="flex items-center gap-4 md:gap-6">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <span key={l.href} className="flex items-center gap-1.5">
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
                {l.soon && (
                  <span className="label-soft text-[0.5rem] text-faint bg-ink2 px-1 py-0.5 leading-none">
                    Soon
                  </span>
                )}
              </span>
            );
          })}
          <a
            href="https://cowlprotocol.com/docs"
            className="hidden md:inline label-mono text-[0.72rem] text-muted hover:text-bone transition-colors"
          >
            Docs
          </a>
        </nav>
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
