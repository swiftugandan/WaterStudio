/**
 * WaterStudio design tokens: the single source for colour, type, spacing, shape,
 * elevation, motion and data colour ramps. `tokens.css` is generated from this file
 * (`pnpm --filter @waterstudio/ui build`); components use the CSS custom properties,
 * and the renderer reads the same values from here.
 *
 * Colour is defined in two layers. `palette` holds raw colours and is never used by
 * components directly. `themes` maps semantic roles (surface, text, accent, ...) to
 * palette colours for each theme, so a theme can change without touching components.
 */

export const palette = {
  white: '#ffffff',
  black: '#000000',
  neutral: {
    25: '#fbfcfd',
    50: '#f5f7fa',
    100: '#edf0f4',
    150: '#e3e7ed',
    200: '#d5dbe3',
    300: '#b8c1cd',
    400: '#8d98a8',
    500: '#677385',
    600: '#4e5969',
    700: '#3b4452',
    750: '#2f3743',
    800: '#272e38',
    850: '#1f252e',
    900: '#171c23',
    950: '#0f1318',
    1000: '#0a0d11',
  },
  // Brand: the blue of deep water.
  blue: {
    50: '#eef6ff',
    100: '#d9ebff',
    200: '#b9daff',
    300: '#89c2ff',
    400: '#519ffc',
    500: '#2b7ff0',
    600: '#1a63d6',
    700: '#174fae',
    800: '#18448d',
    900: '#1a3b72',
    950: '#13254a',
  },
  teal: { 300: '#5fd4cc', 500: '#0f9f9a', 700: '#0a6e6b' },
  green: { 50: '#ecf8f0', 300: '#6fd497', 600: '#1d7f46', 950: '#0d2a19' },
  amber: { 50: '#fff6e5', 300: '#f5c45e', 700: '#8f5800', 950: '#2e1f05' },
  red: { 50: '#fdeeee', 300: '#f28b8b', 600: '#c02a2a', 950: '#33100f' },
  orange: { 400: '#ff9c3a', 600: '#e8590c', 700: '#b6460a' },
  purple: { 300: '#c39bff', 600: '#7440b8' },
} as const;

/** Semantic colour roles. Every theme defines every role. */
export interface ThemeColors {
  /** Behind everything: the window and the gaps between panels. */
  bgApp: string;
  /** Panels, menus and dialogs. */
  bgSurface: string;
  /** Panel headers, the ribbon's tab strip, table headers. */
  bgSurfaceAlt: string;
  /** Inputs and wells set into a surface. */
  bgSunken: string;
  bgHover: string;
  bgActive: string;
  borderSubtle: string;
  borderDefault: string;
  /** Borders of controls (inputs, checkboxes); at least 3:1 against the surface. */
  borderControl: string;
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
  textOnAccent: string;
  accent: string;
  accentHover: string;
  accentSubtle: string;
  /** Focus ring; at least 3:1 against the surface. */
  focus: string;
  successText: string;
  successBg: string;
  warningText: string;
  warningBg: string;
  dangerText: string;
  dangerBg: string;
  infoText: string;
  infoBg: string;
  /** The CAD canvas. */
  canvasBg: string;
  canvasGrid: string;
  canvasLink: string;
  canvasNode: string;
  canvasLabel: string;
  canvasSelection: string;
  canvasHover: string;
  /** Series colours for charts, in order; distinguishable with common colour-vision deficiencies. */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
}

export type ThemeName = 'light' | 'dark';

const n = palette.neutral;
const b = palette.blue;

export const themes: Record<ThemeName, ThemeColors> = {
  light: {
    bgApp: n[100],
    bgSurface: palette.white,
    bgSurfaceAlt: n[50],
    bgSunken: n[50],
    bgHover: n[100],
    bgActive: b[100],
    borderSubtle: n[150],
    borderDefault: n[200],
    borderControl: '#7f8a9a',
    textPrimary: n[900],
    textSecondary: n[600],
    textDisabled: n[400],
    textOnAccent: palette.white,
    accent: b[600],
    accentHover: b[700],
    accentSubtle: b[50],
    focus: b[500],
    successText: palette.green[600],
    successBg: palette.green[50],
    warningText: palette.amber[700],
    warningBg: palette.amber[50],
    dangerText: palette.red[600],
    dangerBg: palette.red[50],
    infoText: b[700],
    infoBg: b[50],
    canvasBg: n[25],
    canvasGrid: n[150],
    canvasLink: n[700],
    canvasNode: n[900],
    canvasLabel: n[600],
    canvasSelection: palette.orange[600],
    canvasHover: b[500],
    chart1: b[600],
    chart2: palette.orange[700],
    chart3: palette.green[600],
    chart4: palette.purple[600],
    chart5: palette.red[600],
    chart6: palette.teal[700],
  },
  dark: {
    bgApp: n[1000],
    bgSurface: n[900],
    bgSurfaceAlt: n[850],
    bgSunken: n[950],
    bgHover: n[800],
    bgActive: b[950],
    borderSubtle: '#232a33',
    borderDefault: n[750],
    borderControl: '#6d7889',
    textPrimary: '#e8ecf1',
    textSecondary: '#a3adba',
    textDisabled: '#687384',
    textOnAccent: '#06121f',
    accent: b[400],
    accentHover: b[300],
    accentSubtle: b[950],
    focus: b[300],
    successText: palette.green[300],
    successBg: palette.green[950],
    warningText: palette.amber[300],
    warningBg: palette.amber[950],
    dangerText: palette.red[300],
    dangerBg: palette.red[950],
    infoText: b[300],
    infoBg: b[950],
    canvasBg: '#0d1116',
    canvasGrid: '#1c222a',
    canvasLink: '#9aa6b5',
    canvasNode: '#d7dde5',
    canvasLabel: '#a3adba',
    canvasSelection: palette.orange[400],
    canvasHover: b[300],
    chart1: b[400],
    chart2: palette.orange[400],
    chart3: palette.green[300],
    chart4: palette.purple[300],
    chart5: palette.red[300],
    chart6: palette.teal[300],
  },
};

/** Spacing on a 4 px grid. Keys are steps; `space[4]` is 16 px. */
export const space = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = { none: 0, sm: 3, md: 5, lg: 8, xl: 12, full: 9999 } as const;

export const font = {
  sans: '"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  mono: '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Type scale in px. The interface's base size is `md` (13 px), as in desktop CAD tools. */
export const fontSize = { xs: 11, sm: 12, md: 13, lg: 15, xl: 18, '2xl': 22, '3xl': 28 } as const;
export const lineHeight = { tight: 1.2, normal: 1.45, relaxed: 1.6 } as const;
export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

/** Density changes control and row heights, never type size. */
export type DensityName = 'comfortable' | 'compact';
export const density: Record<
  DensityName,
  { control: number; row: number; ribbonLarge: number; gap: number }
> = {
  comfortable: { control: 30, row: 28, ribbonLarge: 72, gap: 8 },
  compact: { control: 24, row: 22, ribbonLarge: 60, gap: 4 },
};

export const shadow: Record<ThemeName, { sm: string; md: string; lg: string }> = {
  light: {
    sm: '0 1px 2px rgb(16 24 40 / 0.08)',
    md: '0 4px 12px rgb(16 24 40 / 0.12), 0 1px 3px rgb(16 24 40 / 0.08)',
    lg: '0 12px 32px rgb(16 24 40 / 0.18), 0 2px 6px rgb(16 24 40 / 0.10)',
  },
  dark: {
    sm: '0 1px 2px rgb(0 0 0 / 0.5)',
    md: '0 4px 12px rgb(0 0 0 / 0.55), 0 1px 3px rgb(0 0 0 / 0.5)',
    lg: '0 12px 32px rgb(0 0 0 / 0.6), 0 2px 6px rgb(0 0 0 / 0.5)',
  },
};

export const motion = {
  fast: '100ms',
  normal: '160ms',
  slow: '240ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const zIndex = {
  base: 0,
  dock: 10,
  ribbon: 20,
  dropdown: 100,
  overlay: 200,
  modal: 300,
  toast: 400,
  tooltip: 500,
} as const;

/** Interface icon sizes in px; the ribbon uses 32 for large buttons and 16 elsewhere. */
export const iconSize = { sm: 16, md: 20, lg: 24, ribbon: 32 } as const;

/**
 * Colour ramps for results on the map, as evenly spaced stops from low to high.
 * The defaults are colour-blind safe: viridis and cividis (matplotlib, CC0).
 * `epanet` is EPANET's classic five-class legend. `difference` is a diverging ramp for
 * comparing scenarios (ColorBrewer RdBu, reversed so that blue is lower).
 */
export const colormaps = {
  viridis: [
    '#440154',
    '#472d7b',
    '#3b528b',
    '#2c728e',
    '#21918c',
    '#28ae80',
    '#5ec962',
    '#addc30',
    '#fde725',
  ],
  cividis: [
    '#00204d',
    '#00336f',
    '#39486b',
    '#575c6e',
    '#707173',
    '#8a8678',
    '#a59c74',
    '#c3b369',
    '#ffea46',
  ],
  epanet: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'],
  difference: ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'],
} as const;

export type ColormapName = keyof typeof colormaps;
