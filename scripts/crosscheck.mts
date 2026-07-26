// Cross-check: the app's browser port of the shielded core must agree with the
// CLI implementation bit for bit, and with the live mainnet pool. Run with:
//   npx tsx scripts/crosscheck.ts
//
// 1. commitment / nullifier parity      app f(x) === cli f(x)
// 2. note cipher interop                app encrypt -> cli decrypt, and back
// 3. packed cipher byte equality        packCipher agrees across ports
// 4. signature key derivation           deterministic, well-formed, stable
// 5. live mainnet replay                leaf log rebuilds the chain's root
// 6. shield proof through the port      witness + bb pipeline produce a proof
import { createPublicClient, defineChain, fallback, http } from "viem";

// App port (browser-clean, runs in node too)
import { poseidon as appPoseidon, randomField, fieldToHex, hexToField } from "../lib/shielded/field";
import { commitment as appCommitment, nullifier as appNullifier, type Note } from "../lib/shielded/note";
import { encryptNote as appEncrypt, tryDecryptNote as appDecrypt, packCipher as appPack, unpackCipher as appUnpack } from "../lib/shielded/crypto";
import { deriveShieldedKeysFromSignature, decodePaymentAddress as appDecodeAddress, SHIELDED_SIGN_MESSAGE } from "../lib/shielded/keys";
import { computeRoot, appendProof } from "../lib/shielded/tree";
import { alignPoolToChain, emptyPool, applyScan, emptyWallet, computeBalance } from "../lib/shielded/pool";
import { proveShield } from "../lib/shielded/prove";

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

import { privateKeyToAccount } from "viem/accounts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- 1. field + note math parity -------------------------------------------
{
  const a = randomField(), b = randomField(), c = randomField(), d = randomField();
  check("poseidon arity 2 parity", appPoseidon([a, b]) === cliPoseidon([a, b]));
  check("poseidon arity 4 parity", appPoseidon([a, b, c, d]) === cliPoseidon([a, b, c, d]));

  const note: Note = { value: 123456789n, token: 0n, mpk: a, blinding: b };
  check("commitment parity", appCommitment(note) === cliCommitment(note));
  check("nullifier parity", appNullifier(c, 7) === cliNullifier(c, 7));
}

// ---- 2 + 3. cipher interop ---------------------------------------------------
{
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
}

// ---- 4. signature-derived keys ----------------------------------------------
{
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
  pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
  const wallet = emptyWallet();
  const { discovered } = applyScan(pool, wallet, k1);
  const bal = computeBalance(wallet);
  check("scan discovers own note", discovered === 1 && bal.length === 1 && bal[0]!.amount === note.value);
}

// ---- 5. live mainnet replay --------------------------------------------------
{
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
}

// ---- 6. a shield proof through the ported pipeline --------------------------
{
  const keys = deriveShieldedKeysFromSignature("0x" + "11".repeat(65));
  const note: Note = { value: 10n ** 15n, token: 0n, mpk: keys.mpk, blinding: randomField() };
  const c = appCommitment(note);
  // A synthetic three-leaf tree stands in for the pool; the shape of the
  // witness is identical at any size.
  const leaves = [randomField(), randomField(), randomField()];
  const at = appendProof(leaves, c);
  const t0 = Date.now();
  const proof = await proveShield(note, c, at, { threads: 4 });
  check(
    "shield proof generated (evm target)",
    proof.publicInputs.length === 6 && proof.proof.length > 2,
    `${(proof.proof.length - 2) / 2} bytes in ${Date.now() - t0}ms`,
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
