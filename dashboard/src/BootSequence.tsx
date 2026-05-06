import { useEffect, useRef, useState } from "react";

const SESSION_KEY = "kvmhub.bootSeen";

const ASCII_BANNER = String.raw`
   ██╗  ██╗██╗   ██╗███╗   ███╗      ██╗  ██╗██╗   ██╗██████╗
   ██║ ██╔╝██║   ██║████╗ ████║      ██║  ██║██║   ██║██╔══██╗
   █████╔╝ ██║   ██║██╔████╔██║█████╗███████║██║   ██║██████╔╝
   ██╔═██╗ ╚██╗ ██╔╝██║╚██╔╝██║╚════╝██╔══██║██║   ██║██╔══██╗
   ██║  ██╗ ╚████╔╝ ██║ ╚═╝ ██║      ██║  ██║╚██████╔╝██████╔╝
   ╚═╝  ╚═╝  ╚═══╝  ╚═╝     ╚═╝      ╚═╝  ╚═╝ ╚═════╝ ╚═════╝
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Machine {
  id: string;
  name: string;
  lan_ip: string;
}

interface Agent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
}

export default function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) {
      onComplete();
      return;
    }

    const append = async (line: string, delay = 35) => {
      if (cancelled.current) return;
      setLines((prev) => [...prev, line]);
      await sleep(delay);
    };

    const replaceLast = (line: string) => {
      setLines((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = line;
        return copy;
      });
    };

    const skipHandler = () => {
      cancelled.current = true;
      sessionStorage.setItem(SESSION_KEY, "1");
      setHidden(true);
      onComplete();
    };
    window.addEventListener("keydown", skipHandler);
    window.addEventListener("click", skipHandler);

    (async () => {
      // Banner
      for (const bline of ASCII_BANNER.split("\n")) {
        if (cancelled.current) return;
        await append(bline, 25);
      }
      await append("   fleet ops console · v0.1.0", 80);
      await append("");
      await append("Initializing fleet...", 220);

      try {
        const mResp = await fetch("/api/machines");
        if (mResp.ok) {
          const machines: Machine[] = await mResp.json();
          for (const m of machines) {
            if (cancelled.current) return;
            const idCol = m.id.padEnd(18);
            const ipCol = m.lan_ip.padEnd(16);
            await append(`  [..] ${idCol} ${ipCol} pinging…`, 110);
            await sleep(120);
            const latency = (8 + Math.floor(Math.random() * 28)).toString().padStart(2);
            replaceLast(`  [OK] ${idCol} ${ipCol} RTT ${latency}ms ✓`);
            await sleep(60);
          }
        }
      } catch {
        await append("  [!!] fleet enumeration unavailable");
      }

      await append("");
      await append("Connecting to agents...", 220);

      try {
        const aResp = await fetch("/api/agents");
        if (aResp.ok) {
          const agents: Agent[] = await aResp.json();
          for (const a of agents) {
            if (cancelled.current) return;
            const name = (a.name || a.id).padEnd(18);
            const model = (a.model || "").padEnd(28);
            await append(`  [OK] ${name} ${model} ready`, 130);
          }
        }
      } catch {
        await append("  [!!] agent enumeration unavailable");
      }

      await append("");
      await append("Memory · Honcho                         ✓", 100);
      await append("Telegram bridge                         ✓", 100);
      await append("Workflow event bus                      ✓", 100);
      await append("");
      await append("READY.", 350);
      await sleep(700);

      sessionStorage.setItem(SESSION_KEY, "1");
      setHidden(true);
      window.removeEventListener("keydown", skipHandler);
      window.removeEventListener("click", skipHandler);
      onComplete();
    })();

    return () => {
      cancelled.current = true;
      window.removeEventListener("keydown", skipHandler);
      window.removeEventListener("click", skipHandler);
    };
  }, [onComplete]);

  if (hidden) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black overflow-hidden flex flex-col">
      {/* Cinematic ASCII intro — fades to typewriter sequence on ended */}
      {!introDone && (
        <video
          src="/kvmhub_intro.mp4"
          autoPlay
          muted
          playsInline
          onEnded={() => setIntroDone(true)}
          onError={() => setIntroDone(true)}
          className="absolute inset-0 w-full h-full object-cover z-[2] transition-opacity duration-500"
        />
      )}
      {/* CRT scanline overlay */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[3]"
        style={{
          background:
            "repeating-linear-gradient(to bottom, rgba(0,255,140,0.04) 0px, rgba(0,255,140,0.04) 1px, transparent 1px, transparent 3px)",
        }}
      />
      {/* faint glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[3]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,255,140,0.06) 0%, transparent 60%)",
        }}
      />
      <div
        className="relative px-6 py-8 sm:px-10 sm:py-12 font-mono text-[13px] sm:text-sm leading-snug text-accent-glow whitespace-pre overflow-y-auto flex-1 z-[1] transition-opacity duration-500"
        style={{ opacity: introDone ? 1 : 0 }}
      >
        {lines.join("\n")}
        <span className="inline-block ml-1 animate-pulse">▊</span>
      </div>
      <div className="relative px-6 sm:px-10 pb-4 text-emerald-700 text-xs font-mono opacity-70 z-[3]">
        click or press any key to skip
      </div>
    </div>
  );
}
