"use client";

// Client side of the prove worker: one lazy worker, request/response by id.
// If the worker cannot start (a bundler or browser quirk), proving falls back
// to the main thread — the page freezes for the duration but the proof is the
// same bytes.
import type { Note } from "./note";
import type { Insertion, ShieldProof, SpendPlan, SpendProof } from "./prove";
import type { ProveResponse } from "./proveWorker";

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./proveWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<ProveResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      // The worker failed to boot (or crashed): fail everything in flight and
      // let future proofs take the main-thread path.
      workerBroken = true;
      for (const [, p] of pending) p.reject(new Error("prove worker crashed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function callWorker<T>(msg: Record<string, unknown>): Promise<T> | null {
  const w = getWorker();
  if (!w) return null;
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, ...msg });
  });
}

export async function proveShieldOffThread(note: Note, commitment: bigint, at: Insertion): Promise<ShieldProof> {
  const viaWorker = callWorker<ShieldProof>({ kind: "shield", note, commitment, at });
  if (viaWorker) {
    try {
      return await viaWorker;
    } catch (e) {
      if (!workerBroken) throw e;
      // fall through to the main thread
    }
  }
  const { proveShield } = await import("./prove");
  return proveShield(note, commitment, at, { threads: 1 });
}

export async function proveTransferOffThread(plan: SpendPlan): Promise<SpendProof> {
  const viaWorker = callWorker<SpendProof>({ kind: "transfer", plan });
  if (viaWorker) {
    try {
      return await viaWorker;
    } catch (e) {
      if (!workerBroken) throw e;
      // fall through to the main thread
    }
  }
  const { proveTransfer } = await import("./prove");
  return proveTransfer(plan, { threads: 1 });
}
