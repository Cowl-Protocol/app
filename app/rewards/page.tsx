"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import RewardsCard from "@/components/RewardsCard";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";

export default function Rewards() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            The hood pays <em>its own.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            Rewards in COWL for the people who actually use the protocol. Shield, hold, trade.
            Paid the way everything here is paid, privately.
          </p>
        </div>

        <RewardsCard />
      </main>

      <Footer />
    </div>
  );
}
