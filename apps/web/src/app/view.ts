/** What the map view offers commands (set by the map panel while it is mounted). */
export interface ViewApi {
  fit(): void;
  zoom(factor: number): void;
  zoomTo(handles: number[]): void;
  /** Where a node is on screen, in CSS pixels relative to the map (for tests and tooltips). */
  screenOf(handle: number): [number, number] | null;
}
