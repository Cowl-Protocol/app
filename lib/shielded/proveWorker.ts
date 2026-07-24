// Web Worker that runs the proving pipeline off the main thread, so the page
// stays responsive through the seconds a proof takes. Structured clone carries
// BigInt fine, so plans and notes cross the boundary untouched.
//
// threads: 1 — multithreaded Barretenberg needs SharedArrayBuffer, which needs
// cross-origin isolation headers the static host does not send. Single-threaded
// proving is a few seconds instead of one; correctness is identical.
import { proveShield, proveTransfer } from "./prove";
import type { Insertion, SpendPlan } from "./prove";
import type { Note } from "./note";

export type ProveRequest =
  | { id: number; kind: "shield"; note: Note; commitment: bigint; at: Insertion }
  | { id: number; kind: "transfer"; plan: SpendPlan };

export type ProveResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<ProveRequest>) => {
  const req = e.data;
  try {
    const result =
      req.kind === "shield"
        ? await proveShield(req.note, req.commitment, req.at, { threads: 1 })
        : await proveTransfer(req.plan, { threads: 1 });
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, result } satisfies ProveResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ProveResponse);
  }
};
