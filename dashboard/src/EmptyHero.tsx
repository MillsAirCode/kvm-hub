// EmptyHero.tsx (new file, drop-in)
import { useEffect, useState } from 'react';
import AmbientBackground from './AmbientBackground';

interface EmptyHeroProps {
  glyph?: string;
  tagline?: string;
  opacity?: number;
  minHeight?: string;
  className?: string;
  loading?: boolean;
}

export default function EmptyHero({
  glyph = '//',
  tagline = '',
  opacity = 0.45,
  minHeight = 'min-h-[60vh]',
  className = '',
  loading = false,
}: EmptyHeroProps) {
  const [decode, setDecode] = useState('[░]');

  useEffect(() => {
    if (!loading) return;
    const chars = ['[░]', '[▒]', '[▓]', '[█]', '[▋]', '[▌]'];
    let i = 0;
    const id = setInterval(() => {
      setDecode(chars[i % chars.length]);
      i++;
    }, 90);
    return () => clearInterval(id);
  }, [loading]);

  return (
    <div className={`relative ${minHeight} flex flex-col items-center justify-center overflow-hidden ${className}`}>
      <AmbientBackground opacity={opacity} />
      <div className="relative z-10 flex flex-col items-center gap-3 px-6 py-8 text-center">
        <div className="flex items-center gap-2 text-2xl font-mono tracking-widest">
          <span className="phosphor-soft text-accent-glow">{glyph}</span>
          {loading && <span className="phosphor text-accent-glow">{decode}</span>}
        </div>
        <p className="phosphor-soft text-base font-mono italic text-accent/80">
          {tagline}
          <span className="animate-pulse text-accent-glow">▊</span>
        </p>
      </div>
    </div>
  );
}
