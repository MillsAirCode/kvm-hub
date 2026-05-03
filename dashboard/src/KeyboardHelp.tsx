import { useEffect, useRef, useState, type ReactNode } from 'react';

interface ShortcutGroup {
  title: string;
  shortcuts: { key: string; label: string }[];
}

const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'GLOBAL',
    shortcuts: [
      { key: '?', label: 'Show this help' },
      { key: 'Esc', label: 'Close any modal / palette / overlay' },
      { key: 'Cmd/Ctrl+K', label: 'Open command palette' },
    ],
  },
  {
    title: 'NAVIGATION',
    shortcuts: [
      { key: 'G then L', label: 'Go to Live' },
      { key: 'G then A', label: 'Go to Agents' },
      { key: 'G then F', label: 'Go to Fleet' },
      { key: 'G then O', label: 'Go to Logs' },
      { key: 'G then M', label: 'Go to Memory' },
      { key: 'G then T', label: 'Go to Tasks' },
    ],
  },
  {
    title: 'AGENT',
    shortcuts: [
      { key: '/', label: 'Focus the broadcast composer' },
      { key: 'M', label: 'Toggle sound mute (Settings)' },
      { key: 'R', label: 'Restart hovered agent (desktop only)' },
    ],
  },
];

export default function KeyboardHelp(): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable ||
        target.getAttribute('contenteditable') === 'true';

      if (isInput) return;

      if (e.key === '?') {
        e.preventDefault();
        setIsOpen(prev => !prev);
      } else if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        className="w-full max-w-md border border-emerald-500/40 bg-ink-950/95 rounded-xl shadow-[0_0_32px_rgba(52,211,153,0.2)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700 bg-ink-950/90">
          <span className="font-mono text-emerald-300 phosphor bracket-value">
            KEYBOARD
          </span>
          <button
            onClick={() => setIsOpen(false)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors font-mono text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto scrollbar-thin scrollbar-thumb-ink-700 scrollbar-track-transparent">
          {SHORTCUTS.map((group) => (
            <div key={group.title}>
              <h3 className="term-label text-emerald-300 phosphor-soft mb-2 text-xs tracking-wider">
                {group.title}
              </h3>
              <ul className="space-y-2">
                {group.shortcuts.map((shortcut, idx) => (
                  <li
                    key={`${group.title}-${idx}`}
                    className="flex items-center gap-3"
                  >
                    <kbd className="font-mono bg-ink-800 border border-ink-600 px-1.5 py-0.5 rounded text-xs text-zinc-300 min-w-[3ch] text-center">
                      {shortcut.key}
                    </kbd>
                    <span className="text-zinc-300 text-sm">{shortcut.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-ink-700 bg-ink-950/90">
          <p className="font-mono text-xs text-zinc-500 italic">
            press ? to toggle · esc to close
          </p>
        </div>
      </div>
    </div>
  );
}
