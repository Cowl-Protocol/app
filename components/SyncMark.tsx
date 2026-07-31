"use client";

import InfoTip from "./InfoTip";
import Spinner from "./Spinner";
import { useShielded } from "./ShieldedProvider";

/**
 * What the balance beside it is standing on: a read in flight, or the book
 * already in the store.
 *
 * These two used to be one spinner and one boolean, so there was no way for the
 * screen to say the third thing that can be true — that the read is not coming.
 * Every endpoint serving this chain's history can refuse at once (an archive
 * read wants a token, the explorer rate-limits, a hijacked resolver takes the
 * last one away), and the balance on screen is then the stored one with nothing
 * saying so.
 *
 * Silence is the failure worth avoiding in both directions: a spinner that
 * never stops reads as broken, and no spinner at all reads as fresh. This says
 * which, and names the block, so the claim can be checked rather than believed.
 */
export default function SyncMark({ align = "right" }: { align?: "left" | "right" }) {
  const { syncing, syncStale, syncedBlock } = useShielded();

  if (syncing) return <Spinner className="h-3 w-3 text-acid" />;
  if (!syncStale) return null;

  return (
    <InfoTip
      align={align}
      text={
        `Showing the book already stored, synced ${syncedBlock ? `at block ${syncedBlock}` : "earlier"}. ` +
        "The chain read has not landed — the endpoints that serve this chain's history are slow or refusing. " +
        "Your balance is whatever the chain says; this is the last of it we could read. It clears on its own if the read lands."
      }
    />
  );
}
