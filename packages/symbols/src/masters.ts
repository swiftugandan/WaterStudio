import type { SymbolId } from './catalogue.ts';

/** Every master's SVG text, keyed by symbol id. */
export const symbolMasters: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('./masters/*.svg', { query: '?raw', import: 'default', eager: true }),
  ).map(([path, svg]) => [path.replace('./masters/', '').replace('.svg', ''), svg]),
);

/** A symbol's SVG master. */
export function symbolSvg(id: SymbolId): string {
  const svg = symbolMasters[id];
  if (svg === undefined) throw new Error(`no master for symbol ${id}`);
  return svg;
}
