// Proof generation for the shielded pool, in the browser this time.
//
// Port of cli/src/shielded/prove.ts. The pipeline is identical:
//   noir_js  executes the circuit and produces the witness
//   bb.js    turns that witness into an UltraHonk proof
//
// The load-bearing constants carry over unchanged and will silently produce
// proofs the chain rejects if touched:
//   1. `verifierTarget: "evm"` — the ZK UltraHonk variant with a keccak
//      transcript, which is what the deployed verifier expects.
//   2. `backend: BackendType.Wasm` — same proving path for every user.
//   3. The pinned package versions — @aztec/bb.js must match the bb that wrote
//      the verifying key in ShieldVerifier.sol, @noir-lang/noir_js the nargo
//      that compiled the circuits. package.json pins both to the CLI's.
//
// Browser notes: threads is a parameter because multithreaded WASM needs the
// cross-origin isolation headers a static host may not send — callers pass 1
// there and the proof just takes a little longer. Imports stay dynamic so the
// proving stack loads only when someone actually proves.
import { bytesToHex } from "@noble/hashes/utils";
import { SHIELD_CIRCUIT, TRANSFER_CIRCUIT } from "./circuit";
import { fieldToHex, randomField } from "./field";
import { commitment, nullifier, type Note } from "./note";
import { appendProof, computeRoot, merkleProof, type Append } from "./tree";

/** SRS points to load — the floor the WASM backend accepts, 17MB one-time download. */
const SRS_SIZE = 131072;

export type ProveOptions = {
  /** Barretenberg worker threads. 1 unless the page is cross-origin isolated. */
  threads?: number;
};

export type ShieldProof = {
  /** UltraHonk proof bytes, passed straight to ShieldedPool.shield(). */
  proof: `0x${string}`;
  /** Public inputs in the order shield/src/main.nr declares them. */
  publicInputs: readonly `0x${string}`[];
};

export type Insertion = Append;

/**
 * Prove that `commitment` is a well-formed Poseidon2 commitment to this note,
 * and that appending it at `at.leafIndex` carries the tree from `at.oldRoot`
 * to `at.newRoot`. `oldRoot` must be the pool's root at execution time — if
 * another deposit lands first the proof reverts; sync and reprove.
 */
export async function proveShield(
  note: Note,
  commitment: bigint,
  at: Insertion,
  opts: ProveOptions = {},
): Promise<ShieldProof> {
  const [{ UltraHonkBackend, Barretenberg, BackendType }, { Noir }] = await Promise.all([
    import("@aztec/bb.js"),
    import("@noir-lang/noir_js"),
  ]);
  const noir = new Noir(SHIELD_CIRCUIT as never);
  const { witness } = await noir.execute({
    mpk: fieldToHex(note.mpk),
    blinding: fieldToHex(note.blinding),
    insert_path: at.pathElements.map(fieldToHex),
    insert_right: at.right,
    token: fieldToHex(note.token),
    value: fieldToHex(note.value),
    commitment: fieldToHex(commitment),
    old_root: fieldToHex(at.oldRoot),
    new_root: fieldToHex(at.newRoot),
    leaf_index: fieldToHex(BigInt(at.leafIndex)),
  });

  const api = await Barretenberg.new({
    backend: BackendType.Wasm,
    threads: opts.threads ?? 1,
    srsSize: SRS_SIZE,
  });
  try {
    const backend = new UltraHonkBackend(SHIELD_CIRCUIT.bytecode, api);
    const { proof, publicInputs } = await quietly(() =>
      backend.generateProof(witness, { verifierTarget: "evm" }),
    );
    if (publicInputs.length !== 6) {
      throw new Error(`expected 6 public inputs, got ${publicInputs.length}`);
    }
    return {
      proof: `0x${bytesToHex(proof)}`,
      publicInputs: publicInputs.map(pad32),
    };
  } finally {
    await api.destroy();
  }
}

/** One note being spent, already sitting in the tree at `leafIndex`. */
export type SpendInput = { value: bigint; blinding: bigint; leafIndex: number };
/** One note being created. `mpk` is its owner — the recipient's for a payment, yours for change. */
export type SpendOutput = { mpk: bigint; value: bigint; blinding: bigint };

export type SpendPlan = {
  sk: bigint;
  nk: bigint;
  /** The asset the notes hold. Private — it surfaces only through publicToken, when value leaves. */
  token: bigint;
  /** One or two notes to spend. A single-note spend is padded with a zero-value dummy. */
  inputs: SpendInput[];
  /** Exactly two outputs, in order. Either may be a zero-value filler. */
  outputs: [SpendOutput, SpendOutput];
  /** Every commitment currently in the tree; membership and the append paths derive from it. */
  leaves: bigint[];
  /** The public leg. All zero (value + fee) means nothing leaves and this is a pure private spend. */
  publicToken: bigint;
  publicValue: bigint;
  fee: bigint;
  /** Payout targets as address-fields; 0 when that leg is unused. */
  recipient: bigint;
  relayer: bigint;
  /** Bound into the proof and checked against block.chainid — no cross-chain replay. */
  chainId: bigint;
};

/** The subset of a proof that ShieldedPool.spend's Spend struct consumes. */
export type SpendStruct = {
  membershipRoot: `0x${string}`;
  nullifiers: readonly [`0x${string}`, `0x${string}`];
  commitments: readonly [`0x${string}`, `0x${string}`];
  newRoot: `0x${string}`;
  token: bigint;
  value: bigint;
  fee: bigint;
  recipient: bigint;
  relayer: bigint;
};

export type SpendProof = {
  proof: `0x${string}`;
  /** All 14 public inputs, in the order spend() rebuilds them. */
  publicInputs: readonly `0x${string}`[];
  spend: SpendStruct;
  /** Leaf index the first output lands at; the second is insertIndex + 1. */
  insertIndex: number;
};

const hx = (x: bigint): `0x${string}` => fieldToHex(x) as `0x${string}`;

/**
 * Prove a join-split: up to two input notes are nullified and two outputs are
 * appended, with an optional public leg leaving the pool. The witness mirrors
 * circuits/fixtures.mjs exactly. `plan.leaves` must be the tree as the chain
 * holds it right now — sync immediately before proving.
 */
export async function proveTransfer(plan: SpendPlan, opts: ProveOptions = {}): Promise<SpendProof> {
  if (plan.inputs.length < 1 || plan.inputs.length > 2) {
    throw new Error(`A join-split takes one or two input notes, got ${plan.inputs.length}.`);
  }
  const membershipRoot = computeRoot(plan.leaves);
  const insertIndex = plan.leaves.length;

  const inValue: bigint[] = [];
  const inBlinding: bigint[] = [];
  const inLeafIndex: bigint[] = [];
  const inPath: bigint[][] = [];
  const inRight: boolean[][] = [];
  const nullifiers: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    const real = plan.inputs[i];
    if (real) {
      const mp = merkleProof(plan.leaves, real.leafIndex);
      inValue.push(real.value);
      inBlinding.push(real.blinding);
      inLeafIndex.push(BigInt(real.leafIndex));
      inPath.push(mp.pathElements);
      inRight.push(mp.pathIndices.map((b) => b === 1));
      nullifiers.push(nullifier(plan.nk, real.leafIndex));
    } else {
      // A zero-value dummy. The circuit waives its membership and leaf-index
      // checks; the index lands outside the real 0..2^20 range and stays fresh
      // per spend so its nullifier never collides with an earlier one.
      const dummyIndex = randomField();
      const shape = merkleProof(plan.leaves, plan.inputs[0]!.leafIndex);
      inValue.push(0n);
      inBlinding.push(randomField());
      inLeafIndex.push(dummyIndex);
      inPath.push(shape.pathElements);
      inRight.push(shape.pathIndices.map((b) => b === 1));
      nullifiers.push(nullifier(plan.nk, dummyIndex));
    }
  }

  const outCommitments = plan.outputs.map((o) =>
    commitment({ mpk: o.mpk, token: plan.token, value: o.value, blinding: o.blinding }),
  );
  // Chained appends: the second output lands on the tree the first one produced.
  const append1 = appendProof(plan.leaves, outCommitments[0]!);
  const append2 = appendProof([...plan.leaves, outCommitments[0]!], outCommitments[1]!);
  const newRoot = append2.newRoot;

  const input = {
    sk: fieldToHex(plan.sk),
    token: fieldToHex(plan.token),
    in_value: inValue.map(fieldToHex),
    in_blinding: inBlinding.map(fieldToHex),
    in_leaf_index: inLeafIndex.map(fieldToHex),
    in_path: inPath.map((p) => p.map(fieldToHex)),
    in_right: inRight,
    out_mpk: plan.outputs.map((o) => fieldToHex(o.mpk)),
    out_value: plan.outputs.map((o) => fieldToHex(o.value)),
    out_blinding: plan.outputs.map((o) => fieldToHex(o.blinding)),
    out_path: [append1.pathElements.map(fieldToHex), append2.pathElements.map(fieldToHex)],
    out_right: [append1.right, append2.right],
    membership_root: fieldToHex(membershipRoot),
    nullifiers: nullifiers.map(fieldToHex),
    out_commitments: outCommitments.map(fieldToHex),
    old_root: fieldToHex(membershipRoot),
    new_root: fieldToHex(newRoot),
    insert_index: fieldToHex(BigInt(insertIndex)),
    public_token: fieldToHex(plan.publicToken),
    public_value: fieldToHex(plan.publicValue),
    fee: fieldToHex(plan.fee),
    recipient: fieldToHex(plan.recipient),
    relayer: fieldToHex(plan.relayer),
    chain_id: fieldToHex(plan.chainId),
  };

  const [{ UltraHonkBackend, Barretenberg, BackendType }, { Noir }] = await Promise.all([
    import("@aztec/bb.js"),
    import("@noir-lang/noir_js"),
  ]);
  const noir = new Noir(TRANSFER_CIRCUIT as never);
  const { witness } = await noir.execute(input);

  const api = await Barretenberg.new({
    backend: BackendType.Wasm,
    threads: opts.threads ?? 1,
    srsSize: SRS_SIZE,
  });
  try {
    const backend = new UltraHonkBackend(TRANSFER_CIRCUIT.bytecode, api);
    const { proof, publicInputs } = await quietly(() =>
      backend.generateProof(witness, { verifierTarget: "evm" }),
    );
    if (publicInputs.length !== 14) {
      throw new Error(`expected 14 public inputs, got ${publicInputs.length}`);
    }
    return {
      proof: `0x${bytesToHex(proof)}`,
      publicInputs: publicInputs.map(pad32),
      spend: {
        membershipRoot: hx(membershipRoot),
        nullifiers: [hx(nullifiers[0]!), hx(nullifiers[1]!)],
        commitments: [hx(outCommitments[0]!), hx(outCommitments[1]!)],
        newRoot: hx(newRoot),
        token: plan.publicToken,
        value: plan.publicValue,
        fee: plan.fee,
        recipient: plan.recipient,
        relayer: plan.relayer,
      },
      insertIndex,
    };
  } finally {
    await api.destroy();
  }
}

/** Run `fn` with console.log muted — bb.js chats on stdout mid-proof. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** bb.js returns field elements already 0x-prefixed; make the width explicit anyway. */
function pad32(hex: string): `0x${string}` {
  const raw = hex.replace(/^0x/, "");
  if (raw.length > 64) throw new Error(`public input wider than 32 bytes: ${hex}`);
  return `0x${raw.padStart(64, "0")}`;
}
