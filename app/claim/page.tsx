"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import ClaimCard from "@/components/ClaimCard";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";

export default function Claim() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            Claimed by many. Seen by <em>no one.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            A fixed batch of COWL, first come first served. It lands in your
            shielded balance, where only you can read it.
          </p>
        </div>

        <ClaimCard />
      </main>

      <Footer />
    </div>
  );
}
