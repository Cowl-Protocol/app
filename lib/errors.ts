"use client";

// Raw failures, said in words a person can act on.
//
// Everything below the UI speaks in stack traces: viem prints request bodies,
// the pool reverts with bare error names, the relayer answers in HTTP codes.
// None of that tells someone at the card what actually went wrong or what to
// do next — and almost every failure here is recoverable, which the message
// should say before anything else. The raw first line rides along underneath
// for anyone debugging.
//
// Order matters: the wallet's own "user rejected" wording appears inside
// otherwise scary messages, so it is matched first, and the specific contract
// error names are matched before the generic network shapes.

export type ExplainedError = {
  /** What happened and what to do, one or two sentences. */
  what: string;
  /** The raw first line, when it adds anything the sentence does not. */
  detail?: string;
};

const firstLine = (msg: string): string => {
  const line = msg.split("\n")[0] ?? msg;
  return line.length > 180 ? line.slice(0, 177) + "…" : line;
};

type Rule = { test: RegExp; what: string; keepDetail?: boolean };

const RULES: Rule[] = [
  // The person changed their mind — not an error at all.
  { test: /user rejected|denied|rejected the request/i, what: "Rejected in the wallet." },

  // Pool reverts, by name. These are the contract talking.
  {
    test: /UnknownRoot|DuplicateCommitment/,
    what: "The pool advanced while this was proving — someone else's transaction landed first — and the retries ran out. Nothing was spent. Try again.",
  },
  {
    test: /AlreadySpent|RepeatedNullifier/,
    what: "One of these notes is already spent — an earlier attempt likely landed. Refresh and check the balance before trying again.",
    keepDetail: true,
  },
  {
    test: /InvalidProof/,
    what: "The proof did not verify against the pool's current state. Refresh and try again — nothing was spent.",
  },
  {
    test: /ExceedsPooledValue/,
    what: "The pool refuses to pay out more of this token than has been shielded into it.",
  },
  {
    test: /NotMyPayout|NothingToTrade|SameAsset/,
    what: "The trade was built against the wrong route. Refresh the page and build it again.",
    keepDetail: true,
  },

  // The venue.
  {
    test: /STF|Too little received|slippage/i,
    what: "The venue's price moved past the input cap while the proof was being made. It failed closed — nothing was drawn, nothing was broadcast. Try again for a fresh quote.",
  },
  {
    test: /no pool pricing|No trade venue|no venue/i,
    what: "The venue has no pool pricing this pair, so it cannot route.",
  },
  {
    test: /legs do not chain/,
    what: "The trade legs went out of step with the chain. Sync and try again — nothing moved.",
  },

  // The relayer. Every one of these has the same exit: pay the gas yourself.
  {
    test: /no relayer answering/i,
    what: "The relayer did not answer. Retry, or switch Gas payer to “You” and submit it yourself — the spend works either way.",
  },
  {
    test: /gas float/i,
    what: "The relayer has run out of gas float. Switch Gas payer to “You”, or try again later.",
  },
  {
    test: /queue|429.*relay|relay.*429/i,
    what: "The relayer is busy right now. Give it a minute, or switch Gas payer to “You”.",
  },
  {
    test: /reprove/i,
    what: "Gas prices moved and the fee quote went stale mid-run. Run it again — a fresh quote is bound automatically.",
  },

  // The wallet's own funds.
  {
    test: /insufficient funds/i,
    what: "Your wallet does not hold enough ETH to pay this gas.",
  },

  // The plumbing. Nothing moved; these are reads and quotes failing.
  {
    test: /rate.?limit|too many request|429/i,
    what: "The RPC is rate limiting reads right now. Nothing moved — give it a moment and try again.",
    keepDetail: true,
  },
  {
    test: /failed to fetch|fetch failed|network error|load failed|timed? ?out|timeout|econn|socket hang/i,
    what: "A network read failed midway. Nothing moved — check the connection and try again.",
    keepDetail: true,
  },
];

/** Messages the app itself already writes for people — pass them through. */
const ALREADY_HUMAN =
  /Insufficient shielded|too fragmented|cannot cover|Connect a wallet|Shield something|No shielded pool|Even merged/i;

export function explainError(e: unknown): ExplainedError {
  const msg = e instanceof Error ? e.message : String(e);
  const raw = firstLine(msg);
  if (ALREADY_HUMAN.test(msg)) return { what: raw };
  for (const rule of RULES) {
    if (rule.test.test(msg)) {
      return { what: rule.what, detail: rule.keepDetail ? raw : undefined };
    }
  }
  // Unrecognized: say the honest default and keep the raw line as the lead,
  // since in this case it is the only information there is.
  return { what: raw };
}
