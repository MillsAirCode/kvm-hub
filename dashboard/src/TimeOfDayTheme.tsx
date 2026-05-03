import { useEffect } from 'react';

type AccentKey = 'EMERALD' | 'VIOLET' | 'ROSE';

const ACCENT_VALUES: Record<AccentKey, { rgb: string; glow: string; dim: string }> = {
  EMERALD: { rgb: '52 211 153', glow: '110 231 183', dim: '16 185 129' },
  VIOLET:  { rgb: '167 139 250', glow: '196 181 253', dim: '124 92 255' },
  ROSE:    { rgb: '251 113 133', glow: '253 164 175', dim: '225 29 72' },
};

const STORAGE_KEY_AUTO = 'kvm-hub.theme-auto';
const STORAGE_KEY_OVERRIDE = 'kvm-hub.theme-manual-override-ts';
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export default function TimeOfDayTheme() {
  useEffect(() => {
    const applyAccent = (key: AccentKey) => {
      const { rgb, glow, dim } = ACCENT_VALUES[key];
      const root = document.documentElement.style;
      root.setProperty('--accent-rgb', rgb);
      root.setProperty('--accent-glow-rgb', glow);
      root.setProperty('--accent-dim-rgb', dim);
    };

    const checkAndApply = () => {
      // Default to true if key doesn't exist
      const autoEnabled = localStorage.getItem(STORAGE_KEY_AUTO) !== 'false';
      if (!autoEnabled) return;

      const lastManualTs = parseInt(localStorage.getItem(STORAGE_KEY_OVERRIDE) || '0', 10);
      if (Date.now() - lastManualTs < COOLDOWN_MS) return;

      const hour = new Date().getHours();
      let accent: AccentKey = 'VIOLET';
      if (hour >= 6 && hour < 18) accent = 'EMERALD';
      else if (hour >= 18 && hour < 22) accent = 'ROSE';

      applyAccent(accent);
    };

    checkAndApply();
    const intervalId = setInterval(checkAndApply, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  return null;
}
