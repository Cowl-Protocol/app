import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully client-side app — export to static files so it can be served by Caddy on
  // the relayer VPS (no Node process, just files under a web root). Emits to `out/`.
  output: "export",
  images: { unoptimized: true },
  // Dev only. Next serves its chunks and HMR socket to the host it was started
  // on and blocks every other spelling of this machine — reach the dev server
  // as 127.0.0.1 without this and the page arrives as HTML that never
  // hydrates: no fetches, no handlers, nothing but a screenshot of the UI.
  // Sign-in with X sends people to a loopback callback, so both names are in play.
  allowedDevOrigins: ["127.0.0.1", "localhost", "[::1]"],
  turbopack: {
    resolveAlias: {
      // Cut off the Base Account connector's optional-dep subtree (@base-org/account →
      // @coinbase/cdp-sdk → @x402/*), which isn't installed. We don't offer Base Account
      // as a wallet, so this empty module is never used at runtime.
      "@base-org/account": "./stubs/empty.js",
    },
    // Backstop: suppress the "Module not found" from cdp-sdk's optional x402 payment
    // deps — intentionally-unresolved optional dependencies we never call.
    ignoreIssue: [
      { path: "**/@coinbase/cdp-sdk/**" },
      { path: "**/@base-org/account/**" },
    ],
  },
};

export default nextConfig;
