"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import EarnCard from "@/components/EarnCard";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";

export default function Earn() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            Every move <em>pays.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            Each season sets a pot of COWL. Every transaction through the pool grows your share of
            it. Move more, take more.
          </p>
        </div>

        <EarnCard />
      </main>

      <Footer />
    </div>
  );
}
