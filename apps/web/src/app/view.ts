/** What the map view offers commands (set by the map panel while it is mounted). */
export interface ViewApi {
  fit(): void;
  zoom(factor: number): void;
  zoomTo(handles: number[]): void;
  /** Where a node is on screen, in CSS pixels relative to the map (for tests and tooltips). */
  screenOf(handle: number): [number, number] | null;
  /** Pan by a screen offset (for benchmarks and keyboard panning). */
  panBy(dx: number, dy: number): void;
  /** Frames the renderer has drawn and the time spent drawing them (worker CPU ms). */
  frameStats(): { frames: number; ms: number };
  /** The map as on screen, as a standalone SVG with its size in CSS pixels. */
  exportSvg(): { svg: string; width: number; height: number };
}
