/**
 * The renderer core: owns a backend and the latest inputs, and draws a frame when any
 * of them change. It runs in the render worker, or on the main thread where the canvas
 * cannot be transferred.
 */

import type { Atlas } from './atlas.ts';
import type { Backend, BackendName, Frame } from './backend.ts';
import { Canvas2DBackend } from './canvas2d.ts';
import type { CameraState } from './camera.ts';
import type { Scene, ScenePatch } from './scene.ts';
import type { DrawOptions, Paint, Theme } from './style.ts';
import { WebGPUBackend } from './webgpu.ts';

export type Preference = 'auto' | BackendName;

export type ToRenderer =
  | { t: 'scene'; scene: Scene }
  | { t: 'patch'; patch: ScenePatch }
  | { t: 'paint'; paint: Paint }
  | { t: 'flags'; node: Uint8Array; link: Uint8Array }
  | { t: 'theme'; theme: Theme; atlas: Atlas | null }
  | { t: 'options'; options: DrawOptions }
  | { t: 'resize'; width: number; height: number; dpr: number }
  | { t: 'camera'; camera: CameraState };

export type FromRenderer =
  | { t: 'ready'; backend: BackendName; note?: string }
  | { t: 'lost'; reason: string }
  | { t: 'frame'; ms: number; time: number; at: number }
  | { t: 'error'; message: string };

export async function createBackend(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  prefer: Preference,
): Promise<{ backend: Backend; note?: string }> {
  if (prefer !== 'canvas2d') {
    try {
      return { backend: await WebGPUBackend.create(canvas) };
    } catch (e) {
      if (prefer === 'webgpu') throw e;
      const note = `WebGPU unavailable (${e instanceof Error ? e.message : String(e)}); using Canvas 2D`;
      return { backend: new Canvas2DBackend(canvas), note };
    }
  }
  return { backend: new Canvas2DBackend(canvas) };
}

export class RenderCore {
  private camera: CameraState | null = null;
  private dpr = 1;
  private pending = false;
  private readonly schedule: (fn: () => void) => void;

  readonly backend: Backend;
  private readonly emit: (m: FromRenderer) => void;

  constructor(backend: Backend, emit: (m: FromRenderer) => void) {
    this.backend = backend;
    this.emit = emit;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    this.schedule = raf ? (fn) => raf(fn) : (fn) => setTimeout(fn, 16);
    if (backend instanceof WebGPUBackend) {
      backend.onLost = (reason) => this.emit({ t: 'lost', reason });
      backend.onError = (message) => this.emit({ t: 'error', message });
    }
  }

  handle(m: ToRenderer): void {
    switch (m.t) {
      case 'scene':
        this.backend.setScene(m.scene);
        break;
      case 'patch':
        this.backend.patchScene(m.patch);
        break;
      case 'paint':
        this.backend.setPaint(m.paint);
        break;
      case 'flags':
        this.backend.setFlags(m.node, m.link);
        break;
      case 'theme':
        this.backend.setTheme(m.theme, m.atlas);
        break;
      case 'options':
        this.backend.setOptions(m.options);
        break;
      case 'resize':
        this.dpr = m.dpr;
        this.backend.resize(m.width, m.height);
        break;
      case 'camera':
        this.camera = m.camera;
        break;
    }
    this.request();
  }

  request(): void {
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.draw();
    });
  }

  private draw(): void {
    if (!this.camera) return;
    const frame: Frame = { camera: this.camera, dpr: this.dpr };
    const t0 = performance.now();
    try {
      this.backend.render(frame);
    } catch (e) {
      this.emit({ t: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const end = performance.now();
    // `at` is on the absolute clock, comparable across the worker and the page.
    this.emit({ t: 'frame', ms: end - t0, time: t0, at: performance.timeOrigin + end });
  }
}
