"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import SendCard from "@/components/SendCard";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";

export default function Send() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            Pay without <em>naming names.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            Pay from one shielded account to another. No wallet address at either end. The
            amount stays between the two of you.
          </p>
        </div>

        <SendCard wallet={wallet} tab="send" />
      </main>

      <Footer />
    </div>
  );
}
