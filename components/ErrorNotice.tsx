"use client";

// One shape for every failure the cards show: the sentence that says what
// happened and what to do, with the raw line underneath for anyone debugging.
// A bare stack-trace first line in red taught people nothing; this is the
// translation layer's face.
export default function ErrorNotice({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="px-3 py-2 bg-[#2a1010]">
      <p className="text-xs text-[#ff6b6b] leading-relaxed">{message}</p>
      {detail && detail !== message && (
        <p className="mt-1 font-data text-[0.62rem] text-faint break-all leading-relaxed">{detail}</p>
      )}
    </div>
  );
}
