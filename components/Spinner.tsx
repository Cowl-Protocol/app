// Activity indicator, the tapered bars that fade around a circle. Inherits
// currentColor, so it sits in a row without needing to know the palette.
export default function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span className={`activity ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${-0.875 + i * 0.125}s` }} />
      ))}
    </span>
  );
}
