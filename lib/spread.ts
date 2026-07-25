// Timing spread for boundary transactions.
//
// Denominations hide how much crosses; a spread hides when. Firing every part
// in one burst puts them in the same block or the same minute, and a cluster of
// identical deposits at one timestamp is a group whether or not the amounts
// match. Scattering them across a window breaks that.
//
// The offsets are random, not evenly spaced: even spacing is its own signature,
// and a watcher who spots one deposit could predict the next.

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** "45s" · "20m" · "3h" to milliseconds; null when it isn't a window. */
export function parseWindow(spread: string | null | undefined): number | null {
  if (!spread) return null;
  const m = /^(\d+)\s*([smh])$/i.exec(spread.trim());
  if (!m) return null;
  return Number(m[1]) * UNITS[m[2]!.toLowerCase()]!;
}

/**
 * Delays before each part, in order, for a window of `windowMs`.
 *
 * The first part goes immediately — a window that starts by making you wait
 * buys nothing, since there is nothing yet to hide it among — and the rest land
 * at random moments across the window, sorted so they fire in order.
 */
export function planDelays(parts: number, windowMs: number): number[] {
  if (parts <= 1) return [0];
  const moments = [0];
  for (let i = 1; i < parts; i++) moments.push(Math.random() * windowMs);
  moments.sort((a, b) => a - b);
  return moments.map((at, i) => (i === 0 ? 0 : Math.round(at - moments[i - 1]!)));
}

/** "45s" and the like, from milliseconds — for a countdown. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
