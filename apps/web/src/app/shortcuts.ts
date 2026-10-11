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

function hasTextSelection(): boolean {
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  return sel !== null && !sel.isCollapsed && sel.toString().length > 0;
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
        (plain || ['Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+C', 'Mod+V', 'Mod+X'].includes(c.shortcut))
      ) {
        return;
      }
      // Copying selected text (in a report, say) stays the browser's.
      if ((c.shortcut === 'Mod+C' || c.shortcut === 'Mod+X') && hasTextSelection()) return;
      if (!bus.isEnabled(c.id) && (c.shortcut === 'Mod+C' || c.shortcut === 'Mod+V')) return;
      e.preventDefault();
      if (bus.isEnabled(c.id)) bus.execute(c.id);
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
