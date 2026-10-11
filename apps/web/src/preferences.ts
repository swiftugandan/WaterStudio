import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type DensityPref = 'comfortable' | 'compact';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the preference lasts for this page only.
  }
}

/** A per-viewer preference, remembered in this browser when storage is available. */
export function usePreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  useEffect(() => write(key, value), [key, value]);
  return [value, setValue] as const;
}

/** Applies theme and density to the document root, where the design tokens read them. */
export function useApplyPreferences(theme: ThemePref, density: DensityPref): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', density);
  }, [theme, density]);
}
