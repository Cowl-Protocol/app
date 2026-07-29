#!/usr/bin/env node
// Refuse to build a site that would ship someone's local machine as the API.
//
// `next build` reads .env.local, and this app is a static export: whatever is
// in the environment at build time is frozen into out/ and rsynced to the
// public server. A dev's NEXT_PUBLIC_CLAIM_API of 127.0.0.1 therefore becomes
// every visitor's own machine, on a page NEXT_PUBLIC_CLAIM_LIVE has already
// declared open. That combination is worse than a broken page: it advertises a
// live airdrop that cannot work for anyone.
//
// Set ALLOW_LOCAL_BUILD=1 to build the local combination on purpose.

// Next loads .env files itself, so a plain Node script sees none of them. To
// judge what the build will actually bake in, read them the way Next does:
// .env.local over .env, with a real shell variable beating both.
import { readFileSync } from "node:fs";

function parseEnvFile(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const fromFiles = { ...parseEnvFile(".env"), ...parseEnvFile(".env.local") };
const effective = (name) => process.env[name] ?? fromFiles[name] ?? "";

const live = effective("NEXT_PUBLIC_CLAIM_LIVE") === "1";
const api = effective("NEXT_PUBLIC_CLAIM_API");
const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(api.replace(/\/$/, ""));

if (live && loopback && process.env.ALLOW_LOCAL_BUILD !== "1") {
  console.error(
    [
      "",
      "  Build stopped: this would publish a live airdrop pointed at a local address.",
      "",
      `    NEXT_PUBLIC_CLAIM_LIVE = 1`,
      `    NEXT_PUBLIC_CLAIM_API  = ${api}`,
      "",
      "  Static export bakes these in, so every visitor would call their own machine.",
      "",
      "  For a deployable build, set the real service and leave the gate closed until",
      "  the batch opens:",
      "",
      "    NEXT_PUBLIC_CLAIM_API=https://claim.cowlprotocol.com npm run build",
      "",
      "  To build the local combination anyway: ALLOW_LOCAL_BUILD=1 npm run build",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (live) {
  console.warn(`  note: building with the airdrop OPEN, api ${api || "(default)"}`);
}
