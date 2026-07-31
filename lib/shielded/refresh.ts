// What a balance refresh decides, apart from React.
//
// This lives out here so the check beside it exercises the code the screen
// runs rather than a second copy of it. The sibling `*check.mts` scripts model
// the decision they guard and say so; a model can drift from what shipped, and
// this decision is one where drifting back is invisible — the failure it exists
// to prevent looks exactly like the screen working.

/** How a bounded refresh finished, and therefore what the screen should say. */
export type SyncVerdict = {
  /** The read landed: republish the book from the store. */
  publish: boolean;
  /** The book on screen is the stored one. The mark goes up. */
  stale: boolean;
  /** The read is still running past its deadline, so it may yet land. */
  outlived: boolean;
};

/**
 * Wait for a chain read, but not forever.
 *
 * `read` is expected never to reject — the caller settles it into a word first,
 * so that a deadline nobody is waiting on any more cannot leave an unhandled
 * rejection behind.
 *
 * The three outcomes are deliberately distinct. Landing and failing both end
 * the wait; only one of them leaves work running that could still correct the
 * screen, and conflating the two either arms a handler for a read that will
 * never come or drops one that will.
 */
export async function awaitSync(
  read: Promise<"ok" | "failed">,
  deadlineMs: number,
): Promise<SyncVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  try {
    const outcome = await Promise.race([read, deadline]);
    return { publish: outcome === "ok", stale: outcome !== "ok", outlived: outcome === null };
  } finally {
    // A tab that refreshes often would otherwise hold one live timer per
    // refresh until each one fired.
    clearTimeout(timer);
  }
}

/**
 * One run at a time, shared with everyone who asks while it is going.
 *
 * The refresh above stops waiting before the read stops working, so a second
 * refresh arriving in that window would otherwise start a second full log
 * replay against the same stored book — two writers, one book. Callers in that
 * window join the read already running.
 */
export function singleFlight<T>(): (start: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (start) => {
    if (inFlight) return inFlight;
    const run = start();
    inFlight = run;
    const clear = () => {
      if (inFlight === run) inFlight = null;
    };
    // Both arms: the slot has to free even when the run fails, or one failure
    // would wedge every later refresh onto a promise that already settled.
    void run.then(clear, clear);
    return run;
  };
}
