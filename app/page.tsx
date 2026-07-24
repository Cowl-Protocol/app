"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import SwapCard from "@/components/SwapCard";
import MaskLogo from "@/components/MaskLogo";
import Banner from "@/components/Banner";

export default function Home() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            Trade <em>unseen.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            Swap through the shielded pool. Hide your edge from the crowd, not from the law.
          </p>
        </div>

        <SwapCard wallet={wallet} />
      </main>

      <footer className="px-6 md:px-10 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-faint">
        <span className="flex items-center gap-2 label-mono text-[0.62rem]">
          <MaskLogo className="h-2.5 w-auto text-acid" />
          © Cowl Protocol
        </span>
        <div className="flex items-center gap-5">
          <a href="https://cowlprotocol.com" className="label-mono text-[0.62rem] hover:text-bone transition-colors">
            Home
          </a>
          <a href="https://cowlprotocol.com/docs" className="label-mono text-[0.62rem] hover:text-bone transition-colors">
            Docs
          </a>
          <a
            href="https://github.com/Cowl-Protocol"
            className="label-mono text-[0.62rem] hover:text-bone transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
