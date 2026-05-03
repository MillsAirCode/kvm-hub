import { useState, useRef, useEffect, type ReactNode, type MouseEvent } from "react";

/**
 * Click-to-copy wrapper with phosphor flash + ✓ glyph reveal on success.
 *
 * Use to make any inline IDs/IPs/paths/model names tap-to-copy. Falls back
 * to document.execCommand("copy") via a hidden textarea when the clipboard
 * API is unavailable (insecure context, blocked permission). Mobile-friendly
 * tap target (min-h 24px).
 */

interface CopyableTextProps {
  value: string;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function CopyableText({
  value,
  children,
  className = "",
  title = "click to copy",
}: CopyableTextProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* silent — neither path worked, swallow to avoid console noise */
      }
      document.body.removeChild(ta);
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = setTimeout(() => setCopied(false), 800);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      aria-label={title}
      className={`group inline-flex items-center gap-1.5 min-h-[24px] px-1.5 py-0.5 rounded
                  cursor-pointer border border-transparent
                  hover:border-emerald-500/30 hover:underline decoration-emerald-400/50 underline-offset-4
                  transition-colors duration-200
                  ${copied ? "animate-copy-flash" : ""}
                  ${className}`}
    >
      <span
        className={`font-mono text-sm leading-none select-all ${
          copied ? "text-emerald-300 phosphor" : "phosphor-soft"
        }`}
      >
        {children || value}
      </span>
      <span
        className={`transition-opacity duration-200 ${
          copied ? "animate-check-pop" : "opacity-0 pointer-events-none"
        }`}
      >
        <span className="text-emerald-300 phosphor text-xs font-bold">✓</span>
      </span>
    </button>
  );
}
