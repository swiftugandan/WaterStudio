/** Keyboard shortcuts: `Mod+Shift+K` style strings, matched against key events. */

import type { CommandBus } from '@waterstudio/core';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcutLabel(s: string): string {
  return s
    .split('+')
    .map((k) =>
      k === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : k === 'ArrowLeft' ? '←' : k === 'ArrowRight' ? '→' : k,
    )
    .join(isMac ? '' : '+');
}

function matches(shortcut: string, e: KeyboardEvent): boolean {
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  const want = new Set(parts);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (want.has('Alt') !== e.altKey) return false;
  if (!isMac && !want.has('Mod') && e.metaKey) return false;
  return e.key.toLowerCase() === key.toLowerCase() || e.code === key;
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Install global shortcuts; returns a function that removes them. */
export function installShortcuts<C>(bus: CommandBus<C>): () => void {
  const onKey = (e: KeyboardEvent) => {
    const inField = typing(e.target);
    for (const c of bus.all()) {
      if (!c.shortcut || !matches(c.shortcut, e)) continue;
      // Single keys and Delete belong to the field being typed in.
      const plain = !c.shortcut.includes('Mod') && !c.shortcut.includes('Alt') && !c.shortcut.startsWith('F');
      if (
        inField &&
        (plain || c.shortcut === 'Mod+A' || c.shortcut === 'Mod+Z' || c.shortcut === 'Mod+Shift+Z')
      ) {
        return;
      }
      e.preventDefault();
      if (bus.isEnabled(c.id)) bus.execute(c.id);
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
