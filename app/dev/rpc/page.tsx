"use client";

// Hidden diagnostics: what the app is actually pointed at, and what each read
// really returns. Exists because a zero on a balance card cannot tell you
// whether it read zero, read the wrong chain, or failed and said zero anyway.
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { activeNetwork, DEFAULT_NETWORK, NETWORKS } from "@/lib/networks";
import { TOKENS } from "@/lib/tokens";
import { fetchBalance, publicClient } from "@/lib/useWallet";
import { poolAddress } from "@/lib/shielded/contract";

type Row = { label: string; value: string; ok?: boolean };

export default function RpcDiagnostics() {
  const { address, chainId } = useAccount();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);

  const net = activeNetwork();

  const run = useCallback(async () => {
    setRunning(true);
    const out: Row[] = [];
    const stored = (() => {
      try {
        return window.localStorage.getItem("cowl.network");
      } catch {
        return null;
      }
    })();

    out.push({ label: "app network", value: `${net.key} (chainId ${net.chainId})` });
    out.push({ label: "stored choice", value: stored ?? `none, default ${DEFAULT_NETWORK}` });
    out.push({
      label: "wallet chainId",
      value: chainId === undefined ? "not connected" : String(chainId),
      ok: chainId === undefined ? undefined : chainId === net.chainId,
    });
    out.push({ label: "wallet address", value: address ?? "not connected" });
    out.push({ label: "endpoints", value: net.rpcUrls.join("\n") });
    out.push({ label: "pool", value: poolAddress(net) ?? "not deployed" });
    setRows([...out]);

    try {
      const head = await publicClient.getBlockNumber();
      out.push({ label: "head block", value: String(head), ok: true });
    } catch (e) {
      out.push({ label: "head block", value: (e as Error).message.split("\n")[0]!, ok: false });
    }
    setRows([...out]);

    if (address) {
      for (const token of TOKENS) {
        try {
          const raw = await fetchBalance(address, token);
          out.push({
            label: `balance ${token.symbol}`,
            value: `${formatUnits(raw, token.decimals)}  (raw ${raw})`,
            ok: true,
          });
        } catch (e) {
          out.push({ label: `balance ${token.symbol}`, value: (e as Error).message.split("\n")[0]!, ok: false });
        }
        setRows([...out]);
      }
    }

    setRunning(false);
  }, [address, chainId, net]);

  useEffect(() => {
    run();
  }, [run]);

  const switchTo = (key: string) => {
    try {
      window.localStorage.setItem("cowl.network", key);
    } catch {
      /* storage blocked */
    }
    window.location.reload();
  };

  return (
    <div className="min-h-screen grain px-4 py-10">
      <div className="max-w-2xl mx-auto bg-card p-6">
        <div className="flex items-center justify-between mb-5 gap-3">
          <span className="label-mono text-[0.72rem] text-bone">RPC diagnostics</span>
          <button onClick={run} disabled={running} className="label-soft text-muted hover:text-bone disabled:opacity-50">
            {running ? "Running…" : "Re-run"}
          </button>
        </div>

        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="bg-ink2 px-4 py-2.5 flex items-start justify-between gap-4">
              <span className="label-soft text-faint shrink-0 pt-0.5">{r.label}</span>
              <span
                className={`font-data text-xs text-right whitespace-pre-wrap break-all ${
                  r.ok === false ? "text-[#ff6b6b]" : r.ok === true ? "text-acid" : "text-muted"
                }`}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2">
          <span className="label-soft text-faint">Force network</span>
          {Object.keys(NETWORKS).map((k) => (
            <button
              key={k}
              onClick={() => switchTo(k)}
              className={`px-2.5 py-1 text-xs font-data transition-colors ${
                k === net.key ? "bg-acid text-ink" : "bg-ink2 text-muted hover:text-bone"
              }`}
            >
              {NETWORKS[k]!.testnet ? "testnet" : "mainnet"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
