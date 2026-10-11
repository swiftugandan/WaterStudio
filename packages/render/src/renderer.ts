/**
 * The renderer as the app sees it: owns a canvas inside a container element, a camera,
 * and a render worker (or a main-thread core where OffscreenCanvas is unavailable).
 * If the GPU device is lost it swaps in a fresh canvas drawn with Canvas 2D and says
 * why, so the status bar can show which backend runs.
 */

import { buildAtlas, type Atlas } from './atlas.ts';
import type { BackendName } from './backend.ts';
import { Camera } from './camera.ts';
import { createBackend, RenderCore, type FromRenderer, type Preference, type ToRenderer } from './core.ts';
import { Picker, type Hit } from './picking.ts';
import type { Scene } from './scene.ts';
import { defaultDrawOptions, type DrawOptions, type Paint, type Theme } from './style.ts';

export interface RendererStatus {
  backend: BackendName | null;
  note?: string;
  error?: string;
}

export interface RendererOptions {
  prefer?: Preference;
  /** Draw in a worker (default) or on the main thread. */
  worker?: boolean;
  onStatus?: (s: RendererStatus) => void;
  onFrame?: (ms: number) => void;
}

export class Renderer {
  readonly camera = new Camera();
  status: RendererStatus = { backend: null };
  private canvas!: HTMLCanvasElement;
  private worker: Worker | null = null;
  private core: RenderCore | null = null;
  private scene: Scene | null = null;
  private picker: Picker | null = null;
  private last: Partial<Record<ToRenderer['t'], ToRenderer>> = {};
  private readonly container: HTMLElement;
  private readonly options: RendererOptions;
  private destroyed = false;

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.container = container;
    this.options = options;
    this.start(options.prefer ?? 'auto');
  }

  private start(prefer: Preference): void {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ws-canvas';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.canvas);
    const useWorker = (this.options.worker ?? true) && 'transferControlToOffscreen' in this.canvas;
    if (useWorker) {
      const off = this.canvas.transferControlToOffscreen();
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        name: 'ws-render',
      });
      this.worker.onmessage = (e: MessageEvent<FromRenderer>) => this.receive(e.data);
      this.worker.postMessage({ t: 'init', canvas: off, prefer }, [off]);
      this.replay();
    } else {
      void createBackend(this.canvas, prefer).then(
        ({ backend, note }) => {
          if (this.destroyed) {
            backend.destroy();
            return;
          }
          this.core = new RenderCore(backend, (m) => this.receive(m));
          this.receive(
            note === undefined
              ? { t: 'ready', backend: backend.name }
              : { t: 'ready', backend: backend.name, note },
          );
          this.replay();
        },
        (e: unknown) => this.receive({ t: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  private replay(): void {
    for (const m of Object.values(this.last)) this.post(m);
  }

  private receive(m: FromRenderer): void {
    if (this.destroyed) return;
    switch (m.t) {
      case 'ready':
        {
          const note = m.note ?? this.status.note;
          this.status = note === undefined ? { backend: m.backend } : { backend: m.backend, note };
        }
        this.options.onStatus?.(this.status);
        break;
      case 'lost':
        this.restart('canvas2d', `GPU device lost (${m.reason}); switched to Canvas 2D`);
        break;
      case 'error':
        this.status = { ...this.status, error: m.message };
        this.options.onStatus?.(this.status);
        break;
      case 'frame':
        this.options.onFrame?.(m.ms);
        break;
    }
  }

  private restart(prefer: Preference, note: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.core?.backend.destroy();
    this.core = null;
    this.canvas.remove();
    this.status = { backend: null, note };
    this.start(prefer);
  }

  private post(m: ToRenderer): void {
    this.last[m.t] = m;
    if (this.worker) this.worker.postMessage(m);
    else this.core?.handle(m);
  }

  get currentScene(): Scene | null {
    return this.scene;
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.picker = new Picker(scene);
    this.post({ t: 'scene', scene });
  }

  setPaint(paint: Paint): void {
    this.post({ t: 'paint', paint });
  }

  setFlags(node: Uint8Array, link: Uint8Array): void {
    this.post({ t: 'flags', node, link });
  }

  async setTheme(theme: Theme): Promise<void> {
    let atlas: Atlas | null = null;
    try {
      atlas = await buildAtlas(theme);
    } catch {
      // Without symbols the network still draws; tanks and valves just lack glyphs.
    }
    this.post({ t: 'theme', theme, atlas });
  }

  setOptions(options: Partial<DrawOptions>): void {
    this.post({ t: 'options', options: { ...defaultDrawOptions, ...options } });
  }

  /** Match the canvas to the container's size. Call on resize. */
  resize(): void {
    const r = this.container.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    this.camera.resize(r.width, r.height);
    this.post({
      t: 'resize',
      width: Math.max(1, Math.round(r.width * dpr)),
      height: Math.max(1, Math.round(r.height * dpr)),
      dpr,
    });
    this.redraw();
  }

  /** Draw the current camera. Cheap to call on every pointer move. */
  redraw(): void {
    this.post({ t: 'camera', camera: this.camera.state() });
  }

  fit(): void {
    if (this.scene) this.camera.fit(this.scene.bounds, 32);
    this.redraw();
  }

  pick(sx: number, sy: number, tolerance?: number): Hit | null {
    return this.picker?.pick(this.camera, sx, sy, tolerance) ?? null;
  }

  queryScreenRect(x0: number, y0: number, x1: number, y1: number, crossing: boolean) {
    const [ax, ay] = this.camera.toWorld(Math.min(x0, x1), Math.max(y0, y1));
    const [bx, by] = this.camera.toWorld(Math.max(x0, x1), Math.min(y0, y1));
    return (
      this.picker?.query({ minX: ax, minY: ay, maxX: bx, maxY: by }, crossing) ?? { nodes: [], links: [] }
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.worker?.terminate();
    this.core?.backend.destroy();
    this.canvas.remove();
  }
}
