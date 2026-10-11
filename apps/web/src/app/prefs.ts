/** Per-viewer preferences, remembered in this browser when storage is available. */

import type { Preference } from '@waterstudio/render';
import { Emitter } from './emitter.ts';

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

export class Prefs extends Emitter {
  theme = read<ThemePref>('ws.theme', ['system', 'light', 'dark'], 'system');
  density = read<DensityPref>('ws.density', ['comfortable', 'compact'], 'comfortable');
  renderer = read<Preference>('ws.renderer', ['auto', 'webgpu', 'canvas2d'], 'auto');

  constructor() {
    super();
    this.apply();
  }

  set(p: Partial<{ theme: ThemePref; density: DensityPref; renderer: Preference }>): void {
    if (p.theme) this.theme = p.theme;
    if (p.density) this.density = p.density;
    if (p.renderer) this.renderer = p.renderer;
    write('ws.theme', this.theme);
    write('ws.density', this.density);
    write('ws.renderer', this.renderer);
    this.apply();
    this.emit();
  }

  /** The theme actually shown, resolving "system". */
  get resolvedTheme(): 'light' | 'dark' {
    if (this.theme !== 'system') return this.theme;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  private apply(): void {
    const root = document.documentElement;
    if (this.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.theme);
    root.setAttribute('data-density', this.density);
  }
}
