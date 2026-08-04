/**
 * The one rule that keeps a shielded account safe.
 *
 * The unlock signature is deterministic, so it derives the same keys every time
 * from any page that can get the wallet to produce it. That makes it the
 * account rather than a login, and the rule follows: it is only ever worth
 * signing here.
 *
 * It sits next to the unlock steps and in the footer on purpose. The warning
 * inside the signed message only works on someone already expecting it, so the
 * rule has to be familiar from the calm moments, not read for the first time in
 * a wallet prompt raised by a lookalike site.
 */
export default function SignNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      // Muted rather than faint: this is the one line in the footer that has to
      // be read rather than merely available, and faint on ink is too dim to
      // survive being skimmed past.
      <span className="label-mono text-[0.62rem] text-muted">
        Only sign the unlock message on app.cowlprotocol.com
      </span>
    );
  }

  return (
    <p className="text-[0.7rem] text-warn leading-relaxed">
      Your unlock signature is your shielded account. Cowl only asks for it on
      app.cowlprotocol.com, so don&apos;t sign that message anywhere else.
    </p>
  );
}
