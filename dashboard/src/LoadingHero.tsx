import React from 'react';
import AmbientBackground from './AmbientBackground';

export interface LoadingHeroProps {
  /** Brand label, e.g. "BUILD" / "SYNC" / "FETCH" */
  brand?: string;
  /** Main status line */
  tagline: string;
  /** Optional sub-text (file name being downloaded, host being restarted, etc) */
  subtext?: string;
  /** Optional progress 0..1. If omitted, shows indeterminate animation. */
  progress?: number;
  /** Optional structured stats line e.g. "12.4 / 17.6 GB · 5.2 MB/s · 2:03 left" */
  stats?: string;
  /** Container size hints */
  minHeight?: string;
  /** Pass-through className */
  className?: string;
}

export default function LoadingHero(props: LoadingHeroProps): React.ReactNode {
  const { brand, tagline, subtext, progress, stats, minHeight, className } = props;
  
  const isDeterminate = progress !== undefined;
  const clampedProgress = Math.max(0, Math.min(1, progress ?? 0));
  const filledCells = Math.floor(clampedProgress * 30);
  const percent = Math.round(clampedProgress * 100);

  const indeterminatePattern = '░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒'.slice(0, 30);

  return (
    <>
      <style>{`
        @keyframes cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes edge-pulse {
          0%, 100% { 
            color: rgb(var(--accent-rgb, 16 185 129)); 
            text-shadow: 0 0 6px rgb(var(--accent-rgb, 16 185 129)); 
          }
          50% { 
            color: #ffffff; 
            text-shadow: 0 0 10px #ffffff, 0 0 20px rgb(var(--accent-rgb, 16 185 129)); 
          }
        }
        @keyframes scan-move {
          0% { transform: translateX(0); }
          100% { transform: translateX(calc(100% - 3ch)); }
        }
        .animate-cursor-blink { animation: cursor-blink 1s step-end infinite; }
        .animate-edge-pulse { animation: edge-pulse 1.5s ease-in-out infinite; }
        .animate-scan-move { animation: scan-move 300ms infinite alternate linear; will-change: transform; }
      `}</style>

      <div
        className={`relative overflow-hidden rounded-lg border border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm ${className || ''}`}
        style={{ minHeight }}
      >
        <AmbientBackground opacity={0.4} />
        
        <div className="relative z-10 flex flex-col items-center justify-center gap-4 p-6 scanlines">
          {/* Brand */}
          <div className="bracket-value phosphor tracking-widest text-sm font-bold uppercase">
            [{brand || 'LOADING'}]
          </div>

          {/* Tagline + CRT Cursor */}
          <div className="phosphor text-xl font-mono flex items-center gap-1.5">
            <span>{tagline}</span>
            <span className="animate-cursor-blink inline-block w-2.5 h-5 align-middle leading-none">▊</span>
          </div>

          {/* Subtext */}
          {subtext && (
            <div className="text-zinc-500 font-mono italic text-sm">
              {subtext}
            </div>
          )}

          {/* Progress / Indeterminate Bar */}
          <div className="flex flex-col items-center gap-2 w-full max-w-md mt-2">
            {isDeterminate ? (
              <div className="flex items-center gap-3 w-full">
                <div className="font-mono text-sm tracking-wider flex gap-0.5">
                  {Array.from({ length: 30 }, (_, i) => {
                    const isFilled = i < filledCells;
                    const isEdge = i === filledCells && filledCells < 30;
                    const isLastFilled = filledCells === 30 && i === 29;
                    const char = isFilled ? '▰' : '▱';
                    let cls = isFilled ? 'phosphor' : 'text-zinc-700';
                    if (isEdge || isLastFilled) cls += ' animate-edge-pulse';
                    return <span key={i} className={cls}>{char}</span>;
                  })}
                </div>
                <div className="phosphor-soft font-mono text-sm tabular-nums min-w-[3ch] text-right">
                  {percent}%
                </div>
              </div>
            ) : (
              <div className="relative w-[30ch] h-6 flex items-center justify-center overflow-hidden font-mono text-sm">
                <div className="absolute inset-0 flex items-center justify-center text-zinc-700 select-none">
                  {indeterminatePattern.split('').map((char, i) => (
                    <span key={i}>{char}</span>
                  ))}
                </div>
                <div className="absolute inset-0 flex items-center justify-start text-emerald-400 animate-scan-move select-none">
                  <span>███</span>
                </div>
              </div>
            )}
          </div>

          {/* Stats */}
          {stats && (
            <div className="text-zinc-600 font-mono text-xs mt-1 term-label">
              {stats}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
