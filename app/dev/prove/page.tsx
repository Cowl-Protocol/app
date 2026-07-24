"use client";

// Hidden smoke test for the in-browser proving pipeline: boots the prove
// worker, generates one synthetic shield proof, and reports timing. No wallet,
// no chain writes — safe to run any time. First run downloads the proving
// stack (worker bundle plus the one-time 17MB CRS), so it is slower once.
import { useEffect, useRef, useState } from "react";
import { randomField } from "@/lib/shielded/field";
import { commitment, type Note } from "@/lib/shielded/note";
import { deriveShieldedKeysFromSignature } from "@/lib/shielded/keys";
import { appendProof } from "@/lib/shielded/tree";
import { proveShieldOffThread } from "@/lib/shielded/prover";

type State =
  | { phase: "idle" }
  | { phase: "running"; note: string }
  | { phase: "pass"; ms: number; bytes: number }
  | { phase: "fail"; error: string };

export default function ProveSmoke() {
  const [state, setState] = useState<State>({ phase: "idle" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        setState({ phase: "running", note: "proving a synthetic deposit in the worker…" });
        const keys = deriveShieldedKeysFromSignature("0x" + "22".repeat(65));
        const note: Note = { value: 10n ** 15n, token: 0n, mpk: keys.mpk, blinding: randomField() };
        const c = commitment(note);
        const at = appendProof([randomField(), randomField()], c);
        const t0 = performance.now();
        const proof = await proveShieldOffThread(note, c, at);
        const ms = Math.round(performance.now() - t0);
        if (proof.publicInputs.length !== 6) throw new Error(`expected 6 public inputs, got ${proof.publicInputs.length}`);
        setState({ phase: "pass", ms, bytes: (proof.proof.length - 2) / 2 });
      } catch (e) {
        setState({ phase: "fail", error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  return (
    <div className="min-h-screen grain flex items-center justify-center px-4">
      <div className="bg-card p-6 max-w-md w-full">
        <p className="label-mono text-[0.72rem] text-bone mb-4">Prove pipeline smoke test</p>
        {state.phase === "running" && (
          <p className="text-sm text-muted">
            <span className="inline-block h-3 w-3 mr-2 align-middle border-2 border-acid border-t-transparent rounded-full spin" />
            {state.note}
          </p>
        )}
        {state.phase === "pass" && (
          <p className="font-data text-sm text-acid">
            PASS · {state.bytes} bytes in {(state.ms / 1000).toFixed(1)}s
          </p>
        )}
        {state.phase === "fail" && (
          <p className="font-data text-xs text-[#ff6b6b] break-all">FAIL · {state.error}</p>
        )}
        <p className="text-[0.7rem] text-faint mt-4 leading-relaxed">
          Synthetic proof only. First run downloads the proving stack and the one-time CRS, so give
          it a moment; runs after that are seconds.
        </p>
      </div>
    </div>
  );
}
