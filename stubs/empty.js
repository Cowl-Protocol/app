// Stub for @base-org/account.
//
// The Base Account wallet connector is intentionally NOT in our wallet list
// (see lib/wagmi.ts). RainbowKit's index statically references @wagmi/connectors'
// baseAccount connector, whose lazy `import('@base-org/account')` pulls in
// @coinbase/cdp-sdk → @x402/* — packages that aren't installed and break the
// Turbopack build with "Module not found: @x402/core/client".
//
// Aliasing @base-org/account to this empty module (next.config.ts turbopack
// resolveAlias) stops Turbopack from descending into that subtree. The connector's
// connect() method never runs at runtime because Base Account isn't offered, so the
// empty module is never actually used.
export {};
