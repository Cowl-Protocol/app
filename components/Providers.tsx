"use client";

import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "@/lib/wagmi";
import ShieldedProvider from "./ShieldedProvider";

// Cowl-themed RainbowKit modal: acid accent on the committed dark world.
const cowlTheme = darkTheme({
  accentColor: "#d7fb08",
  accentColorForeground: "#0a0b0e",
  borderRadius: "none",
  fontStack: "system",
  overlayBlur: "small",
});

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={cowlTheme} modalSize="compact">
          <ShieldedProvider>{children}</ShieldedProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
