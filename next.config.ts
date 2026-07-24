import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully client-side app — export to static files so it can be served by Caddy on
  // the relayer VPS (no Node process, just files under a web root). Emits to `out/`.
  output: "export",
  images: { unoptimized: true },
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
