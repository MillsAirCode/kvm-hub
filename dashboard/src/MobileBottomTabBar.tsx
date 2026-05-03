import type { ReactNode } from 'react';
import { TAB_ICONS, type Tab } from './App';

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function MobileBottomTabBar({
  tab,
  setTab,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
}): ReactNode {
  const tabs: Tab[] = ["live", "agents", "fleet", "logs", "memory", "tasks"];

  return (
    <nav
      role="tablist"
      aria-label="Fleet dashboard navigation"
      className="fixed bottom-0 left-0 right-0 lg:hidden z-40 border-t border-ink-800/80 backdrop-blur bg-ink-950/70"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="relative">
        {/* Tab Grid */}
        <div className="relative flex justify-around items-center h-[56px]">
          {tabs.map((key) => {
            const isActive = tab === key;
            const IconNode = TAB_ICONS[key];

            return (
              <button
                key={key}
                role="tab"
                aria-selected={isActive}
                aria-controls={`panel-${key}`}
                aria-label={`${key} tab`}
                onClick={() => setTab(key)}
                className={`
                  relative flex flex-col items-center justify-center gap-1.5
                  h-full min-w-[48px] px-2
                  transition-all duration-150 ease-out
                  active:scale-95 touch-manipulation select-none
                  ${isActive ? 'text-accent-glow' : 'text-zinc-500 hover:text-zinc-300 active:text-zinc-300'}
                `}
              >
                {/* Active Top Accent Bar */}
                <span
                  className={`
                    absolute top-0 left-0 right-0 h-[2px]
                    transition-all duration-200 ease-out
                    ${isActive ? 'bg-accent shadow-[0_0_8px_rgba(var(--accent-rgb),0.7)]' : 'bg-transparent'}
                  `}
                />

                {/* Icon Container (clips SVG to exact 14x14 box) */}
                <span className="relative z-10 w-[14px] h-[14px] flex items-center justify-center overflow-hidden">
                  {IconNode}
                </span>

                {/* Mono Label */}
                <span className="relative z-10 text-[10px] tracking-widest font-mono uppercase">
                  {key}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
