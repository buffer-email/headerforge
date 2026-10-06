/**
 * Renders a header value with dynamic tokens (`{{$uuid}}`, `{{$timestamp}}`, …)
 * highlighted as tinted mono chips. Purely presentational — token resolution
 * still happens in the extension worker (lib/dnr).
 */
export function TokenText({ value, className }: { value: string; className?: string }) {
  const parts = value.split(/(\{\{[^{}]*\}\})/g);
  return (
    <span className={`token-text ${className ?? ""}`}>
      {parts.map((part, index) =>
        part.startsWith("{{") && part.endsWith("}}") ? (
          <span className="token-chip" key={index}>
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}
