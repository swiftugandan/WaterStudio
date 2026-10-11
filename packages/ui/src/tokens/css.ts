/** Turns the design tokens into CSS custom properties (`--ws-*`). */

import {
  colormaps,
  density,
  font,
  fontSize,
  fontWeight,
  iconSize,
  lineHeight,
  motion,
  radius,
  shadow,
  space,
  themes,
  zIndex,
  type ThemeColors,
  type ThemeName,
} from './tokens.ts';

/** `bgSurfaceAlt` -> `bg-surface-alt`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function stepName(step: string): string {
  return step.replace('.', '_');
}

function themeVars(theme: ThemeName): string[] {
  const colors: ThemeColors = themes[theme];
  const vars = Object.entries(colors).map(([k, v]) => `--ws-color-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(shadow[theme])) vars.push(`--ws-shadow-${k}: ${v};`);
  vars.push(`color-scheme: ${theme};`);
  return vars;
}

function block(selector: string, lines: string[], indent = ''): string {
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join('\n')}\n${indent}}`;
}

export function tokensToCss(): string {
  const base: string[] = [];
  for (const [k, v] of Object.entries(space)) base.push(`--ws-space-${stepName(k)}: ${v}px;`);
  for (const [k, v] of Object.entries(radius)) base.push(`--ws-radius-${k}: ${v}px;`);
  base.push(`--ws-font-sans: ${font.sans};`, `--ws-font-mono: ${font.mono};`);
  for (const [k, v] of Object.entries(fontSize)) base.push(`--ws-font-size-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(lineHeight)) base.push(`--ws-line-height-${k}: ${v};`);
  for (const [k, v] of Object.entries(fontWeight)) base.push(`--ws-font-weight-${k}: ${v};`);
  for (const [k, v] of Object.entries(motion)) base.push(`--ws-motion-${k}: ${v};`);
  for (const [k, v] of Object.entries(zIndex)) base.push(`--ws-z-${k}: ${v};`);
  for (const [k, v] of Object.entries(iconSize)) base.push(`--ws-icon-${k}: ${v}px;`);
  for (const [name, stops] of Object.entries(colormaps)) {
    base.push(`--ws-ramp-${name}: linear-gradient(90deg, ${stops.join(', ')});`);
  }
  const densityVars = (d: keyof typeof density) =>
    Object.entries(density[d]).map(([k, v]) => `--ws-size-${kebab(k)}: ${v}px;`);

  return [
    '/* Generated from src/tokens/tokens.ts by scripts/build-tokens.ts. Do not edit. */',
    '',
    block(':root', [...base, ...densityVars('comfortable'), ...themeVars('light')]),
    '',
    block('[data-theme="dark"]', themeVars('dark')),
    '',
    '@media (prefers-color-scheme: dark) {',
    block(':root:not([data-theme="light"])', themeVars('dark'), '  '),
    '}',
    '',
    block('[data-density="compact"]', densityVars('compact')),
    '',
    '@media (prefers-reduced-motion: reduce) {',
    block(':root', ['--ws-motion-fast: 0ms;', '--ws-motion-normal: 0ms;', '--ws-motion-slow: 0ms;'], '  '),
    '}',
    '',
  ].join('\n');
}
