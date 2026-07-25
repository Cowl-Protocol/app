"use client";

import { useWallet } from "@/lib/useWallet";
import Header from "@/components/Header";
import SendCard from "@/components/SendCard";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";

export default function Receive() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen flex flex-col grain">
      <Banner />
      <Header wallet={wallet} />

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="text-center mb-8 max-w-lg">
          <h1 className="display text-4xl md:text-5xl leading-[1.05]">
            Get paid. <em>Stay unread.</em>
          </h1>
          <p className="text-muted text-sm mt-3 max-w-sm mx-auto">
            One address to hand out, as many times as you like. What lands behind it is yours to
            see and nobody else&apos;s to count.
          </p>
        </div>

        <SendCard wallet={wallet} tab="receive" />
      </main>

      <Footer />
    </div>
  );
}
