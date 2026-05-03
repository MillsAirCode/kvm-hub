import { useState } from "react";

/**
 * Embeds Telegram Web (the K version) for a specific bot, via the
 * /tg/* reverse proxy on our backend (which strips X-Frame-Options).
 *
 * First-time use requires a Telegram login inside the iframe — phone +
 * code. Auth persists in localStorage scoped to the dashboard's origin.
 *
 * The MTProto WebSocket connects directly from the browser to Telegram's
 * servers, not via our proxy, so latency is unaffected.
 */
export default function TelegramEmbed({
  botUsername,
  agentName,
  height = 480,
}: {
  botUsername: string | null | undefined;
  agentName: string;
  height?: number;
}) {
  const [reload, setReload] = useState(0);

  if (!botUsername) {
    return (
      <div
        className="rounded-lg border border-ink-700 bg-ink-900/40 grid place-items-center text-xs text-zinc-500 italic"
        style={{ minHeight: height }}
      >
        no Telegram bot configured for {agentName}
      </div>
    );
  }

  // The K client picks up the deep-link from the URL hash.
  const src = `/tg/k/?embed=1#@${encodeURIComponent(botUsername)}`;

  return (
    <div
      className="rounded-lg border border-ink-700 bg-ink-900/60 overflow-hidden relative"
      style={{ minHeight: height }}
    >
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        <a
          href={`/tg/k/#@${encodeURIComponent(botUsername)}`}
          target="_blank"
          rel="noreferrer"
          className="text-[9px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded bg-ink-900/80 border border-ink-700"
          title="Open in a new tab"
        >
          ↗
        </a>
        <button
          onClick={() => setReload((r) => r + 1)}
          className="text-[9px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded bg-ink-900/80 border border-ink-700"
          title="Reload iframe"
        >
          ↻
        </button>
      </div>
      <iframe
        key={reload}
        src={src}
        title={`Telegram chat — ${agentName}`}
        className="w-full"
        style={{ height, border: 0, display: "block" }}
        // Telegram Web needs a permissive sandbox to access localStorage,
        // run scripts, open popups for media, allow same-origin requests.
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads"
        allow="clipboard-read; clipboard-write; camera; microphone"
        loading="lazy"
      />
    </div>
  );
}
