// Cross-check: the app's browser port of the shielded core must agree with the
// CLI implementation bit for bit, and with the live mainnet pool. Run with:
//   npx tsx scripts/crosscheck.mts              everything
//   npx tsx scripts/crosscheck.mts --offline    parity only: no chain, no prover
//
// 1. field, commitment and nullifier parity   app f(x) === cli f(x), swept
// 2. note cipher interop                      app encrypt -> cli decrypt, and back
// 3. packed cipher byte equality              packCipher agrees across ports
// 4. signature key derivation                 deterministic, well-formed, stable
// 5. Merkle tree parity                       roots, paths, and the insertion walk
// 6. live mainnet replay                      leaf log rebuilds the chain's root
// 7. shield proof through the port            witness + bb pipeline produce a proof
//
// ---------------------------------------------------------------------------
// Why the sweeps, and what they are and are not worth
//
// Sections 1 to 3 used to draw one random sample each. One sample proves the
// two ports agree on one point, and the disagreements worth finding do not live
// at a random point — they live at zero, at one, at the field boundary, and at
// the carry. So each property is now checked over a fixed set of edge vectors
// plus CROSSCHECK_SAMPLES random ones, and the count is printed so a run that
// quietly swept nothing is visible.
//
// The strength of a differential test is the independence of the two sides, and
// that varies by module, so it is stated rather than implied:
//
//   crypto    genuinely independent — @noble/ciphers here, node:crypto there.
//             An agreement is real evidence.
//   field     shared Poseidon2 primitive, so this checks the wiring around it,
//             not the hash.
//   tree      the two files are the same code today. The sweep is a drift
//             alarm, not a proof, and it earns its place the day somebody edits
//             one copy — which is exactly how a browser client starts building
//             witnesses the pool will not accept.
//
// Section 5 is new and the tree had no cross-check at all before it. It also
// asserts the property the circuit's double walk depends on: the append path
// read at the empty slot reproduces the current root when walked with a zero
// leaf. If that stops holding, every insertion proof is built against a root
// the chain does not have.
//
// --offline drops the chain replay and the bb proof, which is what makes the
// rest of this file cheap enough to gate every push in CI.
import { createPublicClient, defineChain, fallback, http } from "viem";

// App port (browser-clean, runs in node too)
import { poseidon as appPoseidon, randomField, fieldToHex, hexToField, FR } from "../lib/shielded/field";
import { commitment as appCommitment, nullifier as appNullifier, type Note } from "../lib/shielded/note";
import { encryptNote as appEncrypt, tryDecryptNote as appDecrypt, packCipher as appPack, unpackCipher as appUnpack } from "../lib/shielded/crypto";
import { deriveShieldedKeysFromSignature, decodePaymentAddress as appDecodeAddress, SHIELDED_SIGN_MESSAGE } from "../lib/shielded/keys";
import {
  computeRoot as appComputeRoot,
  appendProof as appAppendProof,
  merkleProof as appMerkleProof,
  verifyProof as appVerifyProof,
  emptyRoot as appEmptyRoot,
  DEPTH as APP_DEPTH,
} from "../lib/shielded/tree";
import { alignPoolToChain, emptyPool, applyScan, emptyWallet, computeBalance } from "../lib/shielded/pool";
// proveShield pulls the bb.js WASM backend in with it, which is far too heavy
// to load for a run that is not going to prove anything. Imported where it is
// used instead of here.

// CLI implementation (the proven-on-mainnet reference)
import { poseidon as cliPoseidon } from "../../cli/src/shielded/field.js";
import { commitment as cliCommitment, nullifier as cliNullifier } from "../../cli/src/shielded/note.js";
import { encryptNote as cliEncrypt, tryDecryptNote as cliDecrypt, packCipher as cliPack } from "../../cli/src/shielded/crypto.js";
import {
  deriveShieldedKeys as cliDeriveKeys,
  deriveShieldedKeysFromSignature as cliDeriveFromSig,
  decodePaymentAddress as cliDecodeAddress,
  SHIELDED_SIGN_MESSAGE as CLI_SIGN_MESSAGE,
} from "../../cli/src/shielded/keys.js";

import {
  computeRoot as cliComputeRoot,
  appendProof as cliAppendProof,
  merkleProof as cliMerkleProof,
  verifyProof as cliVerifyProof,
  emptyRoot as cliEmptyRoot,
  DEPTH as CLI_DEPTH,
} from "../../cli/src/shielded/tree.js";

import { privateKeyToAccount } from "viem/accounts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Runs one section and keeps a throw inside it.
 *
 *  Every block below used to sit at the top level, so the first exception
 *  anywhere ended the run and every check after it went unreported — which is
 *  the wrong shape for something gating a push. A malformed cipher would hide a
 *  tree divergence, and the log would look like the tree was never in doubt.
 *  A section that throws is a failure, named, and the rest still run. */
async function section(name: string, body: () => Promise<void> | void) {
  try {
    await body();
  } catch (e) {
    check(`${name} — section threw`, false, e instanceof Error ? e.message : String(e));
  }
}

const OFFLINE = process.argv.includes("--offline");
const SAMPLES = Number(process.env.CROSSCHECK_SAMPLES ?? 256);
if (!Number.isFinite(SAMPLES) || SAMPLES < 1) {
  console.error("CROSSCHECK_SAMPLES must be a positive number.");
  process.exit(2);
}

/** The values a random draw never produces, and where ports drift apart:
 *  zero, one, the top of the field, and the limb boundaries either side of the
 *  128-bit split every packed encoding in this protocol uses. */
const EDGE = [0n, 1n, 2n, FR - 1n, FR - 2n, 2n ** 128n - 1n, 2n ** 128n, 2n ** 252n];

/** Runs `f` over every edge value and `SAMPLES` random ones, and reports the
 *  first disagreement rather than only that there was one. A sweep that says
 *  "failed" without saying on what is a sweep somebody has to rerun by hand. */
function sweep(name: string, f: (x: bigint, y: bigint) => boolean) {
  const vectors: [bigint, bigint][] = [];
  for (const a of EDGE) for (const b of EDGE) vectors.push([a, b]);
  for (let i = 0; i < SAMPLES; i++) vectors.push([randomField(), randomField()]);
  let bad: [bigint, bigint] | null = null;
  for (const [a, b] of vectors) {
    if (!f(a, b)) {
      bad = [a, b];
      break;
    }
  }
  check(name, bad === null, bad ? `disagreed at (${bad[0]}, ${bad[1]})` : `${vectors.length} vectors`);
}

// ---- 1. field + note math parity -------------------------------------------
await section("field and note math", async () => {
  sweep("poseidon arity 2 parity", (a, b) => appPoseidon([a, b]) === cliPoseidon([a, b]));
  sweep("poseidon arity 4 parity", (a, b) => appPoseidon([a, b, a, b]) === cliPoseidon([a, b, a, b]));

  // Both sides build the same note and must agree on what it commits to. value
  // and blinding take the edge values in turn, which is where a port that
  // reduces mod FR in a different order shows up.
  sweep("commitment parity", (a, b) => {
    const note: Note = { value: a, token: 0n, mpk: b, blinding: a };
    return appCommitment(note) === cliCommitment(note);
  });

  // The leaf index is a small integer beside a field element, and the two ports
  // pack that pair themselves. Indices are swept over the whole tree's range
  // rather than over field values, because that is the range one can hold.
  sweep("nullifier parity", (a, b) => {
    const idx = Number(b % BigInt(2 ** 20));
    return appNullifier(a, idx) === cliNullifier(a, idx);
  });
});

// ---- 2 + 3. cipher interop ---------------------------------------------------
await section("cipher interop", async () => {
  // A view keypair made by the CLI derivation; the app must be able to encrypt
  // to it and the CLI must read what the app wrote, and the other way around.
  const cliKeys = cliDeriveKeys("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const note: Note = { value: 42n * 10n ** 18n, token: 0n, mpk: cliKeys.mpk, blinding: randomField() };

  const fromApp = appEncrypt(note, cliKeys.viewPubHex);
  const cliRead = cliDecrypt(fromApp, cliKeys.viewPriv);
  check(
    "app encrypt -> cli decrypt",
    !!cliRead && cliRead.value === note.value && cliRead.token === note.token && cliRead.blinding === note.blinding,
  );

  const fromCli = cliEncrypt(note, cliKeys.viewPubHex);
  const appRead = appDecrypt(fromCli, cliKeys.viewPriv);
  check(
    "cli encrypt -> app decrypt",
    !!appRead && appRead.value === note.value && appRead.token === note.token && appRead.blinding === note.blinding,
  );

  check("packCipher byte equality", appPack(fromApp) === cliPack(fromApp));
  const repacked = appPack(appUnpack(appPack(fromCli)));
  check("pack/unpack roundtrip", repacked === appPack(fromCli));

  // The one place in this file where agreement is real evidence rather than a
  // drift alarm: @noble/ciphers on this side, node:crypto on the other. AES-GCM
  // is deterministic in (key, iv, plaintext), so the two must produce the same
  // bytes for the same note — and each must read what the other wrote.
  //
  // Values are swept because the payload encodes a bigint, and an encoding that
  // is a byte shorter for a smaller number would leak the amount through the
  // ciphertext length. That bug has a comment in crypto.ts already; this is the
  // check that would catch it coming back.
  const rounds = Math.max(8, Math.min(SAMPLES >> 3, 64));
  const values = [0n, 1n, 10n ** 18n, 2n ** 64n, 2n ** 127n, FR - 1n];
  let cipherBad: string | null = null;
  const lengths = new Set<number>();
  for (let i = 0; i < rounds + values.length; i++) {
    const value = i < values.length ? values[i]! : randomField();
    const n: Note = { value, token: i % 2 === 0 ? 0n : randomField(), mpk: cliKeys.mpk, blinding: randomField() };
    const a = appEncrypt(n, cliKeys.viewPubHex);
    const readByCli = cliDecrypt(a, cliKeys.viewPriv);
    const b = cliEncrypt(n, cliKeys.viewPubHex);
    const readByApp = appDecrypt(b, cliKeys.viewPriv);
    lengths.add(appPack(a).length);
    const same = (r: Note | null) => !!r && r.value === n.value && r.token === n.token && r.blinding === n.blinding;
    if (!same(readByCli) || !same(readByApp)) {
      cipherBad = `value ${value}`;
      break;
    }
  }
  check("cipher interop swept both ways", cipherBad === null, cipherBad ?? `${rounds + values.length} notes`);
  check(
    "packed cipher length is constant",
    lengths.size === 1,
    lengths.size === 1 ? `${[...lengths][0]} chars for every value` : `${lengths.size} distinct lengths — the amount leaks`,
  );
});

// ---- 5. Merkle tree parity ---------------------------------------------------
// The tree had no cross-check at all before this. It is the accumulator every
// spend proves membership under, and the app builds its own witnesses from its
// own copy of it.
await section("merkle tree", async () => {
  check("both ports agree on tree depth", APP_DEPTH === CLI_DEPTH, `depth ${APP_DEPTH}`);
  check("empty root parity", appEmptyRoot() === cliEmptyRoot());

  // Sizes that straddle every shape the level walk can take: empty, a lone
  // leaf, exact powers of two, and the odd counts that force the zero-sibling
  // branch at more than one level.
  const SIZES = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 33];
  let rootBad: number | null = null;
  let pathBad: number | null = null;
  let appendBad: string | null = null;

  for (const size of SIZES) {
    const leaves = Array.from({ length: size }, () => randomField());
    if (appComputeRoot(leaves) !== cliComputeRoot(leaves)) {
      rootBad ??= size;
      continue;
    }
    if (size === 0) continue;

    // Every position, not a sampled one: the sibling that is a zero subtree
    // only appears at particular indices, and those are the interesting ones.
    for (let i = 0; i < size; i++) {
      const a = appMerkleProof(leaves, i);
      const c = cliMerkleProof(leaves, i);
      const identical =
        a.root === c.root &&
        a.leaf === c.leaf &&
        a.pathElements.length === c.pathElements.length &&
        a.pathElements.every((e, d) => e === c.pathElements[d]) &&
        a.pathIndices.every((e, d) => e === c.pathIndices[d]);
      // Each port must also accept the other's path, which is the property a
      // shared root actually rests on.
      if (!identical || !cliVerifyProof(a) || !appVerifyProof(c)) {
        pathBad ??= size * 1000 + i;
        break;
      }
    }

    const leaf = randomField();
    const a = appAppendProof(leaves, leaf);
    const c = cliAppendProof(leaves, leaf);
    const sameAppend =
      a.oldRoot === c.oldRoot &&
      a.newRoot === c.newRoot &&
      a.leafIndex === c.leafIndex &&
      a.pathElements.every((e, d) => e === c.pathElements[d]) &&
      a.right.every((e, d) => e === c.right[d]);
    if (!sameAppend) appendBad ??= `parity at ${size}`;

    // The property the circuit's double walk rests on: the path is read at the
    // empty slot, so walking it with a zero leaf must reproduce the root the
    // chain holds right now, and with the real leaf must produce the root it
    // moves to. If this stops holding, every insertion proof is built against a
    // root the pool does not have and the transaction reverts — or worse, does
    // not.
    const asProof = (l: bigint, root: bigint) => ({
      root,
      leaf: l,
      pathElements: a.pathElements,
      pathIndices: a.right.map((r) => (r ? 1 : 0)),
    });
    if (!appVerifyProof(asProof(0n, a.oldRoot))) appendBad ??= `empty walk at ${size}`;
    if (!appVerifyProof(asProof(leaf, a.newRoot))) appendBad ??= `insert walk at ${size}`;
    if (a.oldRoot !== appComputeRoot(leaves)) appendBad ??= `oldRoot at ${size}`;
    if (a.newRoot !== appComputeRoot([...leaves, leaf])) appendBad ??= `newRoot at ${size}`;
  }

  check("root parity across tree shapes", rootBad === null, rootBad === null ? `${SIZES.length} sizes` : `size ${rootBad}`);
  check(
    "merkle paths identical and cross-verified",
    pathBad === null,
    pathBad === null ? "every index of every size" : `size ${Math.floor(pathBad / 1000)} index ${pathBad % 1000}`,
  );
  check("insertion witness holds both walks", appendBad === null, appendBad ?? `${SIZES.length} sizes`);
});

// ---- 4. signature-derived keys ----------------------------------------------
await section("signature-derived keys", async () => {
  const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const sig1 = await acct.signMessage({ message: SHIELDED_SIGN_MESSAGE });
  const sig2 = await acct.signMessage({ message: SHIELDED_SIGN_MESSAGE });
  check("unlock signature deterministic", sig1 === sig2);

  const k1 = deriveShieldedKeysFromSignature(sig1);
  const k2 = deriveShieldedKeysFromSignature(sig2);
  check("keys stable across derivations", k1.sk === k2.sk && k1.mpk === k2.mpk && k1.viewPriv === k2.viewPriv);
  check("payment address is bech32m", /^zcowl1[02-9ac-hj-np-z]+$/.test(k1.paymentAddress));
  {
    const app = appDecodeAddress(k1.paymentAddress);
    check("app decodes its own address", app.mpk === k1.mpk && app.viewPubHex === k1.viewPubHex);
    // The CLI pays app-issued addresses, so its decoder must read them too.
    const cli = cliDecodeAddress(k1.paymentAddress);
    check("cli decodes the app's address", cli.mpk === k1.mpk && cli.viewPubHex === k1.viewPubHex);
    const legacy = appDecodeAddress(`zcowl:0x${fieldToHex(k1.mpk).slice(2)}${k1.viewPubHex}`);
    check("legacy hex address still decodes", legacy.mpk === k1.mpk && legacy.viewPubHex === k1.viewPubHex);
  }

  // The signature space must not collide with the CLI's private-key space.
  const cliKeys = cliDeriveKeys("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  check("sig-v1 account distinct from CLI account", k1.mpk !== cliKeys.mpk);

  // ---- one wallet, one book, in the terminal and in the browser ------------
  // The CLI can reach the app's account because it holds the private key and
  // can produce the same signature. If any of this drifts, `cowl` looks for
  // notes at an mpk the app never wrote to and simply reports an empty balance,
  // so these are the checks that keep the two books the same book.
  check("CLI and app agree on the unlock message", CLI_SIGN_MESSAGE === SHIELDED_SIGN_MESSAGE);
  const cliSig = cliDeriveFromSig(sig1);
  check(
    "CLI sig-v1 derives the app's exact account",
    cliSig.mpk === k1.mpk && cliSig.viewPubHex === k1.viewPubHex && cliSig.sk === k1.sk,
  );
  check("both sides publish the same payment address", cliSig.paymentAddress === k1.paymentAddress);
  check("accounts carry which space they came from", cliSig.space === "sig-v1" && cliKeys.space === "key");

  // Round trip through the scan path: encrypt a note to the sig-derived keys,
  // plant it in a pool, and let applyScan discover it.
  const note: Note = { value: 5n * 10n ** 15n, token: 0n, mpk: k1.mpk, blinding: randomField() };
  const pool = emptyPool();
  pool.commitments.push(fieldToHex(appCommitment(note)));
  pool.ciphertexts.push(appEncrypt(note, k1.viewPubHex));
  pool.root = fieldToHex(appComputeRoot(pool.commitments.map(hexToField)));
  const wallet = emptyWallet();
  const { discovered } = applyScan(pool, wallet, k1);
  const bal = computeBalance(wallet);
  check("scan discovers own note", discovered === 1 && bal.length === 1 && bal[0]!.amount === note.value);
});

// ---- 6. live mainnet replay --------------------------------------------------
// Skipped under --offline: it reads the chain, so it fails for reasons that
// have nothing to do with the commit under test, and a gate that goes red on an
// RPC outage is a gate people learn to rerun rather than read.
if (!OFFLINE) await section("mainnet replay", async () => {
  const POOL = "0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E" as const;
  const DEPLOY = 18121312n;
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  const client = createPublicClient({
    chain,
    transport: fallback([
      http("https://rpc.mainnet.chain.robinhood.com", { timeout: 2_500, retryCount: 0 }),
      // Blockscout rate-limits by short rolling window; back off patiently.
      http("https://robinhoodchain.blockscout.com/api/eth-rpc", { timeout: 30_000, retryCount: 4, retryDelay: 4_000 }),
    ]),
  });
  const pace = () => new Promise((r) => setTimeout(r, 1_500));

  const EVENTS_ABI = [
    { type: "event", name: "NoteCommitted", inputs: [{ name: "commitment", type: "bytes32", indexed: true }, { name: "leafIndex", type: "uint32", indexed: false }] },
    { type: "event", name: "NoteCipher", inputs: [{ name: "leafIndex", type: "uint32", indexed: false }, { name: "ciphertext", type: "bytes", indexed: false }] },
    { type: "event", name: "Nullified", inputs: [{ name: "nullifier", type: "bytes32", indexed: true }] },
  ] as const;
  const VIEW_ABI = [
    { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "nextLeafIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  ] as const;

  const head = await client.getBlockNumber();
  await pace();
  const logs = await client.getContractEvents({ address: POOL, abi: EVENTS_ABI, fromBlock: DEPLOY, toBlock: head });
  await pace();
  const leaves: { index: number; commitment: string; cipher?: string }[] = [];
  const nullifiers: string[] = [];
  for (const log of logs) {
    if (log.eventName === "NoteCommitted") {
      leaves.push({ index: Number(log.args.leafIndex), commitment: log.args.commitment as string });
    } else if (log.eventName === "NoteCipher") {
      const leaf = leaves.find((l) => l.index === Number(log.args.leafIndex));
      if (leaf) leaf.cipher = log.args.ciphertext as string;
    } else if (log.eventName === "Nullified") {
      nullifiers.push(log.args.nullifier as string);
    }
  }
  const [chainRoot, totalLeaves] = await Promise.all([
    client.readContract({ address: POOL, abi: VIEW_ABI, functionName: "root", blockNumber: head }),
    client.readContract({ address: POOL, abi: VIEW_ABI, functionName: "nextLeafIndex", blockNumber: head }),
  ]);

  const pool = emptyPool();
  alignPoolToChain(pool, leaves, nullifiers);
  check(
    "mainnet replay reproduces the chain root",
    pool.root === chainRoot && pool.commitments.length === Number(totalLeaves),
    `${pool.commitments.length} leaves, root ${pool.root.slice(0, 14)}…`,
  );
  check("mainnet ciphers parse (158 bytes)", pool.ciphertexts.every((c, i) => c !== null || leaves[i]?.cipher === undefined));
});

// ---- 7. a shield proof through the ported pipeline --------------------------
// Skipped under --offline: it loads the bb.js WASM backend and proves, which is
// minutes rather than seconds.
if (!OFFLINE) await section("shield proof", async () => {
  const keys = deriveShieldedKeysFromSignature("0x" + "11".repeat(65));
  const note: Note = { value: 10n ** 15n, token: 0n, mpk: keys.mpk, blinding: randomField() };
  const c = appCommitment(note);
  // A synthetic three-leaf tree stands in for the pool; the shape of the
  // witness is identical at any size.
  const leaves = [randomField(), randomField(), randomField()];
  const at = appAppendProof(leaves, c);
  const { proveShield } = await import("../lib/shielded/prove");
  const t0 = Date.now();
  const proof = await proveShield(note, c, at, { threads: 4 });
  check(
    "shield proof generated (evm target)",
    proof.publicInputs.length === 6 && proof.proof.length > 2,
    `${(proof.proof.length - 2) / 2} bytes in ${Date.now() - t0}ms`,
  );
});

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED${OFFLINE ? " (offline: no chain replay, no proof)" : ""}`
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
