import type { Atlas } from './atlas.ts';
import type { CameraState } from './camera.ts';
import type { Scene } from './scene.ts';
import type { DrawOptions, Paint, Theme } from './style.ts';

export type BackendName = 'webgpu' | 'canvas2d';

export interface Frame {
  camera: CameraState;
  /** Device pixels per CSS pixel. */
  dpr: number;
}

/** A drawing backend. Both backends draw the same scene, paint and flags identically. */
export interface Backend {
  readonly name: BackendName;
  setScene(scene: Scene): void;
  setPaint(paint: Paint): void;
  setFlags(node: Uint8Array, link: Uint8Array): void;
  setTheme(theme: Theme, atlas: Atlas | null): void;
  setOptions(options: DrawOptions): void;
  /** Canvas size in device pixels. */
  resize(width: number, height: number): void;
  render(frame: Frame): void;
  destroy(): void;
}
