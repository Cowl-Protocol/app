"use client";

import ConnectButton from "./ConnectButton";
import Logo from "./Logo";
import NetworkSelect from "./NetworkSelect";
import type { useWallet } from "@/lib/useWallet";

type WalletState = ReturnType<typeof useWallet>;

export default function Header({ wallet }: { wallet: WalletState }) {
  return (
    <header className="w-full px-6 md:px-10 py-5 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <a href="https://cowlprotocol.com" className="flex items-center gap-2.5 select-none">
          <Logo className="h-7 w-auto text-acid" />
          <span className="display text-[1.35rem] leading-none">Cowl</span>
        </a>
        <nav className="hidden md:flex items-center gap-6">
          <span className="label-mono text-[0.72rem] text-bone border-b border-acid pb-0.5">Swap</span>
          <span className="label-mono text-[0.72rem] text-faint cursor-not-allowed" title="Coming soon">
            Pool
          </span>
          <span className="label-mono text-[0.72rem] text-faint cursor-not-allowed" title="Coming soon">
            Shield
          </span>
          <a
            href="https://cowlprotocol.com/docs"
            className="label-mono text-[0.72rem] text-muted hover:text-bone transition-colors"
          >
            Docs
          </a>
        </nav>
      </div>

      <div className="flex items-center gap-3">
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
