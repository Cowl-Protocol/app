"use client";

import { shortAddr } from "@/lib/useWallet";
import Spinner from "./Spinner";

type Props = {
  address: string | null;
  connecting: boolean;
  hasWallet: boolean;
  wrongNetwork: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitch: () => void;
  compact?: boolean;
};

export default function ConnectButton({
  address,
  connecting,
  hasWallet,
  wrongNetwork,
  onConnect,
  onDisconnect,
  onSwitch,
  compact,
}: Props) {
  if (address && wrongNetwork) {
    return (
      <button
        onClick={onSwitch}
        className="label-mono text-[0.72rem] px-4 py-2.5 bg-[#3a1414] text-[#ff6b6b] hover:bg-[#4a1818] transition-colors"
      >
        Wrong network · switch
      </button>
    );
  }

  if (address) {
    return (
      <button
        onClick={onDisconnect}
        title="Click to disconnect"
        className="group flex items-center gap-2 label-mono text-[0.72rem] px-4 py-2.5 bg-ink3 hover:bg-[#1c2027] text-bone transition-colors"
      >
        {shortAddr(address)}
      </button>
    );
  }

  return (
    <button
      onClick={onConnect}
      disabled={connecting}
      className="label-mono text-[0.72rem] px-5 py-2.5 bg-acid text-ink hover:bg-acid2 transition-colors disabled:opacity-60"
    >
      {connecting ? (
        <span className="flex items-center justify-center gap-2">
          <Spinner className="h-3 w-3" />
          Connecting
        </span>
      ) : hasWallet ? (
        "Connect wallet"
      ) : compact ? (
        "Get wallet"
      ) : (
        "Get a wallet"
      )}
    </button>
  );
}
