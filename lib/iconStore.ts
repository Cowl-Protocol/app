"use client";

// Which icon hosts are not answering, remembered.
//
// A logo that fails still costs something to try: the browser renders its
// placeholder for the moment before the error arrives, so a wallet full of
// tokenized assets flickers through a row of broken pictures on every visit.
// The failures are not per icon either. They are per host, and they come in
// batches: an issuer serving every one of its logos from a CDN that a region
// cannot reach fails all of them or none.
//
// So the first failure retires the whole host, and glyphs already on screen
// hear about it and drop their images at once rather than each discovering it
// alone. A host is given another chance after a while, since being unreachable
// is usually temporary and pinning it forever would outlast the outage.

const KEY = "cowl.deadIconHosts";
const RETRY_AFTER = 6 * 60 * 60 * 1000;

type Retired = Record<string, number>;

let retired: Retired = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): Retired {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Retired) : {};
  } catch {
    return {};
  }
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(retired));
  } catch {
    /* storage blocked — the in-memory copy still serves this session */
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url, window.location.origin).host;
  } catch {
    return null;
  }
}

/** True when this icon's host has recently refused to serve. */
export function iconIsDead(url: string | undefined): boolean {
  if (!url || typeof window === "undefined") return false;
  const host = hostOf(url);
  if (!host) return false;
  const at = retired[host];
  if (!at) return false;
  if (Date.now() - at < RETRY_AFTER) return true;
  delete retired[host];
  persist();
  return false;
}

/** Retire this icon's host; every glyph on screen stops trying it. */
export function markIconDead(url: string) {
  const host = hostOf(url);
  if (!host || retired[host]) return;
  retired[host] = Date.now();
  persist();
  version += 1;
  for (const fn of listeners) fn();
}

export function subscribeIcons(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function iconsVersion(): number {
  return version;
}

/** The server renders before any of this is known; keep hydration agreeing. */
export function iconsServerVersion(): number {
  return 0;
}
