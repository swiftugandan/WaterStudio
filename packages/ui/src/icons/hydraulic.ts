/**
 * Interface icons for hydraulic actions, drawn on Lucide's grid so they sit beside
 * Lucide's generic icons: 24 × 24, 2 px strokes in `currentColor`, round caps and joins,
 * no fills except where a solid mark carries meaning. These are interface icons for
 * ribbon buttons and menus; the symbols drawn on the map live in @waterstudio/symbols
 * and are deliberately different.
 *
 * Each value is the inner markup of an `<svg viewBox="0 0 24 24">`.
 */

export const hydraulicIcons = {
  junction: '<path d="M3 12h5.5M15.5 12H21"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  reservoir:
    '<path d="M4 6v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6"/>' +
    '<path d="M4 11c1.33 0 1.33-1 2.67-1s1.33 1 2.66 1 1.34-1 2.67-1 1.33 1 2.67 1 1.33-1 2.66-1 1.34 1 2.67 1"/>',
  tank: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 12h14"/><path d="M9 16h6"/>',
  pipe: '<path d="M7.5 16.5l9-9"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/>',
  pump: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  valve: '<path d="M3 7v10l9-5zM21 7v10l-9-5z"/>',
  'valve-prv':
    '<path d="M3 10v10l9-5zM21 10v10l-9-5z"/><path d="M12 15V7"/><path d="M8 7a4 3.5 0 0 1 8 0z"/>',
  'valve-fcv': '<path d="M3 10v10l9-5zM21 10v10l-9-5z"/><path d="M6 5h12"/><path d="M15 2l3 3-3 3"/>',
  'check-valve': '<path d="M3 7v10l9-5z" fill="currentColor"/><path d="M21 7v10l-9-5z"/>',
  pattern: '<path d="M3 20h18"/><path d="M4 16h3v-6h3v3h3V6h3v6h4"/>',
  curve: '<path d="M4 4v16h16"/><path d="M7 7c5 0 8 4 10 10"/>',
  control: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M10 2h4"/>',
  rule: '<path d="M12 3l5 5-5 5-5-5z"/><path d="M12 13v4"/><path d="M7 21h10"/><path d="M7 17v4M17 17v4"/>',
  'run-hydraulics':
    '<path d="M12 2.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 9.5 12 2.5 12 2.5z"/><path d="M10.5 11v6l4.5-3z"/>',
  'run-quality':
    '<path d="M9 3h6"/><path d="M10 3v6.5L4.6 18.4A1.8 1.8 0 0 0 6.1 21h11.8a1.8 1.8 0 0 0 1.5-2.6L14 9.5V3"/><path d="M7 15h10"/>',
  'water-age':
    '<path d="M12 2.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 9.5 12 2.5 12 2.5z"/><path d="M12 11v3.5l2 1.5"/>',
  'fire-flow':
    '<path d="M8.5 21h7"/><path d="M10 21v-9h4v9"/><path d="M9 12h6"/><path d="M10 12V9a2 2 0 0 1 4 0v3"/><path d="M6 15.5h4M14 15.5h4"/>',
  criticality: '<path d="M2 12h7l1.5-3.5 3 7 1.5-3.5h7"/>',
  segments:
    '<path d="M2 12h20"/><path d="M6 8v8M18 8v8"/><path d="M9.5 12h5" stroke-width="4" stroke-linecap="butt"/>',
  demand:
    '<path d="M3 8h8a3 3 0 0 1 3 3v2"/><path d="M3 5v6"/><path d="M12 13h4"/><path d="M14 17v1M14 21v.01"/>',
  emitter: '<circle cx="8" cy="12" r="3"/><path d="M14 8l3-3M15 12h5M14 16l3 3"/>',
  leakage:
    '<path d="M2 7h20M2 12h20"/><path d="M12 14.5s2.5 2.7 2.5 4.2a2.5 2.5 0 0 1-5 0c0-1.5 2.5-4.2 2.5-4.2z"/>',
  pressure: '<path d="M4.5 18a8.5 8.5 0 1 1 15 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14.5" r="1"/>',
  calibrate:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  energy: '<circle cx="9" cy="13" r="6"/><path d="M7.5 10.5l4 2.5-4 2.5z"/><path d="M19 2l-2.5 5H20l-3 6"/>',
  network:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/>' +
    '<path d="M7 6h10M6 7.8l4.9 8.4M18 7.8l-4.9 8.4"/>',
  'split-link': '<path d="M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v4M12 17v4"/>',
  'reverse-link': '<path d="M4 9h15M15 5l4 4-4 4"/><path d="M20 15H5M9 11l-4 4 4 4"/>',
  'merge-links': '<path d="M3 7h5l4 5h9M3 17h5l4-5"/><path d="M18 9l3 3-3 3"/>',
  'add-vertex': '<path d="M3 18l7-7 4 4 7-7"/><rect x="8" y="9" width="4" height="4" fill="currentColor"/>',
  'snap-node': '<circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  'map-theme': '<path d="M4 20l4-12 4 7 3-5 5 10"/><path d="M3 20h18"/>',
  'time-player': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/><path d="M3 12h2M19 12h2"/>',
  profile:
    '<path d="M3 20h18"/><path d="M3 6c3 0 4 4 7 4s4-5 7-5 3 2 4 2"/><path d="M6 20v-4M12 20v-6M18 20v-8"/>',
  contour:
    '<path d="M4 16c3-6 13-6 16 0"/><path d="M7 16c2-3.5 8-3.5 10 0"/><path d="M10 16c1-1.5 3-1.5 4 0"/><path d="M3 20h18"/>',
  scenario:
    '<rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M8 18h11.5a1.5 1.5 0 0 0 1.5-1.5V9"/>',
  proposal: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 14l2 2 4-4"/>',
  agent:
    '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9.5" cy="13" r="1" fill="currentColor"/><circle cx="14.5" cy="13" r="1" fill="currentColor"/><path d="M2 13h3M19 13h3"/>',
} as const;

export type HydraulicIconName = keyof typeof hydraulicIcons;
export const hydraulicIconNames = Object.keys(hydraulicIcons) as HydraulicIconName[];

/** A complete standalone SVG for an icon, for exports and tests. */
export function hydraulicIconSvg(name: HydraulicIconName, size = 24): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${hydraulicIcons[name]}</svg>`
  );
}
