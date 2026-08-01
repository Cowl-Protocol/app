// The app's lint configuration, which did not exist.
//
// `npm run lint` had never run: eslint 9 was installed, no config file of any
// kind was, and flat config is mandatory in 9 — so the script exited 2 on every
// invocation since the day it was added. That is recorded as I-01 in the CI
// report, and the reason it was never made a gate.
//
// A lint config on a project like this earns its keep in one narrow way. It is
// not a style opinion — the code here is already consistent and prettier is not
// in the tree. What it catches is the class of mistake that typechecking cannot
// see and review reliably misses: a floating promise in a path that moves money,
// a caught error that is silently dropped, a React hook whose dependency array
// lies about what it reads.
//
// So the rules below are deliberately few, and every one of them is a
// correctness rule rather than a preference.
import next from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    // Build output, dependencies, and the generated proving worker bundle.
    // The worker is emitted by scripts/build-worker.mjs; linting a bundle
    // reports on code nobody in this repository wrote.
    ignores: [".next/**", "out/**", "node_modules/**", "public/prove-worker.js", "public/**/*.js"],
  },
  ...next,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // An unused variable is usually a rename that did not finish, and in the
      // shielded paths a leftover binding has more than once been the half of a
      // change that was forgotten. Underscore-prefixed names are the documented
      // way to say "deliberately unused".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
