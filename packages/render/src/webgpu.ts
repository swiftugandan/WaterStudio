/// <reference types="@webgpu/types" />
/**
 * The WebGPU backend. Pipe segments are instanced quads whose round caps come from a
 * signed-distance function, with width in screen pixels; junctions are SDF circles;
 * tanks, reservoirs, pumps and valves are sprites from the symbol atlas, link symbols
 * turned to the link's bearing. Colour is a per-element class looked up in a palette,
 * so changing results or selection rewrites one small buffer and rebuilds nothing.
 */

import { atlasIndex, ATLAS_SYMBOLS, type Atlas } from './atlas.ts';
import type { Backend, Frame } from './backend.ts';
import { LINK_SYMBOLS, type Scene } from './scene.ts';
import { defaultDrawOptions, rgb, type DrawOptions, type Paint, type Theme } from './style.ts';

const SHADER = /* wgsl */ `
struct U {
  center: vec2f,
  viewport: vec2f,
  scale: f32,
  dpr: f32,
  lineWidth: f32,
  nodeRadius: f32,
  symbolSize: f32,
  atlasColumns: f32,
  linkOffset: u32,
  pad: u32,
  selection: vec4f,
  hover: vec4f,
  linkPalette: array<vec4f, 16>,
  nodePalette: array<vec4f, 16>,
};
struct P { mode: u32, p1: u32, p2: u32, p3: u32 };

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> state: array<u32>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;
@group(1) @binding(0) var<uniform> pass_: P;

const CORNERS = array<vec2f, 6>(
  vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

fn toPx(p: vec2f) -> vec2f {
  let d = (p - u.center) * u.scale * u.dpr;
  return vec2f(d.x, -d.y) + u.viewport * 0.5;
}
fn toClip(px: vec2f) -> vec4f {
  return vec4f(px.x / u.viewport.x * 2.0 - 1.0, 1.0 - px.y / u.viewport.y * 2.0, 0.0, 1.0);
}
const CULLED = vec4f(0.0, 0.0, -2.0, 1.0);

// Returns false if this element is not drawn in this pass.
fn visible(flags: u32) -> bool {
  if ((flags & 4u) != 0u) { return false; }
  if (pass_.mode == 1u) { return (flags & 1u) != 0u; }
  if (pass_.mode == 2u) { return (flags & 2u) != 0u; }
  return true;
}

struct SegOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) len: f32,
  @location(2) @interpolate(flat) halfw: f32,
  @location(3) @interpolate(flat) color: vec4f,
};

@vertex fn vsSeg(@builtin(vertex_index) vi: u32, @location(0) seg: vec4f, @location(1) link: u32) -> SegOut {
  var o: SegOut;
  let st = state[u.linkOffset + link];
  let flags = (st >> 8u) & 255u;
  if (!visible(flags)) { o.pos = CULLED; return o; }
  var halfw = u.lineWidth * 0.5 * u.dpr;
  var color = u.linkPalette[st & 15u];
  if (pass_.mode == 1u) { halfw = halfw * 2.5; color = u.selection; }
  if (pass_.mode == 2u) { halfw = halfw * 2.5; color = u.hover; }
  let a = toPx(seg.xy);
  let b = toPx(seg.zw);
  let d = b - a;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-6) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let ext = halfw + 1.0;
  let c = CORNERS[vi];
  var along = -ext;
  if (c.x > 0.5) { along = len + ext; }
  let across = c.y * ext;
  o.pos = toClip(a + dir * along + nrm * across);
  o.local = vec2f(along, across);
  o.len = len;
  o.halfw = halfw;
  o.color = color;
  return o;
}

@fragment fn fsSeg(i: SegOut) -> @location(0) vec4f {
  let dx = max(max(-i.local.x, i.local.x - i.len), 0.0);
  let dist = length(vec2f(dx, i.local.y)) - i.halfw;
  let a = clamp(0.5 - dist, 0.0, 1.0) * i.color.a;
  if (a <= 0.0) { discard; }
  return vec4f(i.color.rgb * a, a);
}

struct DotOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) r: f32,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) ring: f32,
};

@vertex fn vsDot(@builtin(vertex_index) vi: u32, @location(0) xy: vec2f, @location(1) node: u32) -> DotOut {
  var o: DotOut;
  let st = state[node];
  let flags = (st >> 8u) & 255u;
  if (!visible(flags)) { o.pos = CULLED; return o; }
  var r = u.nodeRadius * u.dpr;
  var color = u.nodePalette[st & 15u];
  o.ring = 0.0;
  if (pass_.mode == 1u) { r = r + 2.5 * u.dpr; color = u.selection; o.ring = 2.0 * u.dpr; }
  if (pass_.mode == 2u) { r = r + 2.5 * u.dpr; color = u.hover; o.ring = 2.0 * u.dpr; }
  let ext = r + 1.0;
  let c = QUAD[vi] * ext;
  o.pos = toClip(toPx(xy) + c);
  o.local = c;
  o.r = r;
  o.color = color;
  return o;
}

@fragment fn fsDot(i: DotOut) -> @location(0) vec4f {
  var dist = length(i.local) - i.r;
  if (i.ring > 0.0) { dist = abs(length(i.local) - (i.r - i.ring * 0.5)) - i.ring * 0.5; }
  let a = clamp(0.5 - dist, 0.0, 1.0) * i.color.a;
  if (a <= 0.0) { discard; }
  return vec4f(i.color.rgb * a, a);
}

struct SpriteOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vsSprite(@builtin(vertex_index) vi: u32, @location(0) xy: vec2f, @location(1) angle: f32,
                    @location(2) cell: u32, @location(3) elem: u32) -> SpriteOut {
  var o: SpriteOut;
  let st = state[elem];
  let flags = (st >> 8u) & 255u;
  if ((flags & 4u) != 0u) { o.pos = CULLED; return o; }
  let q = QUAD[vi];
  let half = u.symbolSize * 0.5 * u.dpr;
  let ca = cos(angle);
  let sa = sin(angle);
  // Screen y points down, so a counter-clockwise world angle turns clockwise on screen.
  let v = vec2f(q.x * ca + q.y * sa, -q.x * sa + q.y * ca) * half;
  o.pos = toClip(toPx(xy) + v);
  var row = 0.0;
  if ((flags & 1u) != 0u) { row = 1.0; }
  let uv01 = vec2f(q.x * 0.5 + 0.5, q.y * 0.5 + 0.5);
  o.uv = vec2f((f32(cell) + uv01.x) / u.atlasColumns, (row + uv01.y) / 2.0);
  return o;
}

@fragment fn fsSprite(i: SpriteOut) -> @location(0) vec4f {
  let c = textureSample(atlasTex, atlasSampler, i.uv);
  if (c.a <= 0.0) { discard; }
  return vec4f(c.rgb * c.a, c.a);
}
`;

const U_SIZE = 16 * 4 + 2 * 16 + 2 * 16 * 16;
const NODE_ATLAS = [-1, atlasIndex('reservoir'), atlasIndex('tank')];
const LINK_ATLAS = LINK_SYMBOLS.map((s) => (s === 'none' ? -1 : ATLAS_SYMBOLS.indexOf(s)));

export class WebGPUBackend implements Backend {
  readonly name = 'webgpu' as const;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly uniform: GPUBuffer;
  private readonly passBuffers: GPUBuffer[];
  private readonly passGroups: GPUBindGroup[];
  private readonly segPipeline: GPURenderPipeline;
  private readonly dotPipeline: GPURenderPipeline;
  private readonly spritePipeline: GPURenderPipeline;
  private readonly layout0: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private group0: GPUBindGroup | null = null;
  private stateBuffer: GPUBuffer | null = null;
  private segBuffer: GPUBuffer | null = null;
  private dotBuffer: GPUBuffer | null = null;
  private dotCount = 0;
  private nodeSpriteBuffer: GPUBuffer | null = null;
  private nodeSpriteCount = 0;
  private linkSpriteBuffer: GPUBuffer | null = null;
  private linkSpriteCount = 0;
  private atlasTexture: GPUTexture;
  private atlasColumns = 1;
  private scene: Scene | null = null;
  private paint: Paint | null = null;
  private nodeFlags: Uint8Array = new Uint8Array(0);
  private linkFlags: Uint8Array = new Uint8Array(0);
  private theme: Theme | null = null;
  private options: DrawOptions = defaultDrawOptions;
  private stateDirty = true;
  private readonly uniformData = new ArrayBuffer(U_SIZE);
  /** Called if the GPU device is lost, so the host can fall back to Canvas 2D. */
  onLost: ((reason: string) => void) | null = null;
  /** Held so the adapter is not collected while the device lives. */
  adapter: GPUAdapter | null = null;
  /** Called on validation and out-of-memory errors. */
  onError: ((message: string) => void) | null = null;

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<WebGPUBackend> {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('could not get a WebGPU canvas context');
    const backend = new WebGPUBackend(canvas, device, context, gpu.getPreferredCanvasFormat());
    // Keep the adapter alive: if it is collected, some browsers drop the device.
    backend.adapter = adapter;
    return backend;
  }

  private constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    context.configure({ device, format, alphaMode: 'premultiplied' });
    void device.lost.then((info) => this.onLost?.(info.message || 'GPU device lost'));
    device.addEventListener('uncapturederror', (e) => {
      this.onError?.(e.error.message);
    });

    const module = device.createShaderModule({ code: SHADER });
    this.uniform = device.createBuffer({
      size: U_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout0 = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const layout1 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.passBuffers = [0, 1, 2].map((p) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([p, 0, 0, 0]));
      return b;
    });
    this.passGroups = this.passBuffers.map((buffer) =>
      device.createBindGroup({ layout: layout1, entries: [{ binding: 0, resource: { buffer } }] }),
    );
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout0, layout1] });
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const pipeline = (vs: string, fs: string, buffers: GPUVertexBufferLayout[]) =>
      device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    this.segPipeline = pipeline('vsSeg', 'fsSeg', [
      {
        arrayStride: 20,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'uint32' },
        ],
      },
    ]);
    this.dotPipeline = pipeline('vsDot', 'fsDot', [
      {
        arrayStride: 12,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'uint32' },
        ],
      },
    ]);
    this.spritePipeline = pipeline('vsSprite', 'fsSprite', [
      {
        arrayStride: 20,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32' },
          { shaderLocation: 2, offset: 12, format: 'uint32' },
          { shaderLocation: 3, offset: 16, format: 'uint32' },
        ],
      },
    ]);
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.atlasTexture = this.blankTexture();
  }

  private blankTexture(): GPUTexture {
    return this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private buffer(data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
    const b = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    if (data.byteLength > 0)
      this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  }

  setScene(s: Scene): void {
    this.scene = s;
    for (const b of [this.segBuffer, this.dotBuffer, this.nodeSpriteBuffer, this.linkSpriteBuffer])
      b?.destroy();
    // Segments: ax, ay, bx, by (f32) and the link index (u32).
    const seg = new ArrayBuffer(s.segCount * 20);
    const sf = new Float32Array(seg);
    const su = new Uint32Array(seg);
    for (let i = 0; i < s.segCount; i++) {
      sf.set(s.segXY.subarray(4 * i, 4 * i + 4), 5 * i);
      su[5 * i + 4] = s.segLink[i]!;
    }
    this.segBuffer = this.buffer(new Uint8Array(seg), GPUBufferUsage.VERTEX);

    const dots: number[] = [];
    const nodeSprites: number[] = [];
    for (let i = 0; i < s.nodeCount; i++) {
      const x = s.nodeXY[2 * i]!;
      if (Number.isNaN(x)) continue;
      if (s.nodeKind[i] === 0) dots.push(i);
      else nodeSprites.push(i);
    }
    const dot = new ArrayBuffer(dots.length * 12);
    const df = new Float32Array(dot);
    const du = new Uint32Array(dot);
    dots.forEach((n, k) => {
      df[3 * k] = s.nodeXY[2 * n]!;
      df[3 * k + 1] = s.nodeXY[2 * n + 1]!;
      du[3 * k + 2] = n;
    });
    this.dotBuffer = this.buffer(new Uint8Array(dot), GPUBufferUsage.VERTEX);
    this.dotCount = dots.length;

    const sprites = (items: { x: number; y: number; angle: number; cell: number; elem: number }[]) => {
      const buf = new ArrayBuffer(items.length * 20);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      items.forEach((it, k) => {
        f[5 * k] = it.x;
        f[5 * k + 1] = it.y;
        f[5 * k + 2] = it.angle;
        u[5 * k + 3] = it.cell;
        u[5 * k + 4] = it.elem;
      });
      return this.buffer(new Uint8Array(buf), GPUBufferUsage.VERTEX);
    };
    const ns = nodeSprites.map((n) => ({
      x: s.nodeXY[2 * n]!,
      y: s.nodeXY[2 * n + 1]!,
      angle: 0,
      cell: NODE_ATLAS[s.nodeKind[n]!]!,
      elem: n,
    }));
    this.nodeSpriteBuffer = sprites(ns);
    this.nodeSpriteCount = ns.length;
    const ls: { x: number; y: number; angle: number; cell: number; elem: number }[] = [];
    for (let i = 0; i < s.symCount; i++) {
      const cell = LINK_ATLAS[s.symKind[i]!] ?? -1;
      if (cell < 0) continue;
      ls.push({
        x: s.symXY[2 * i]!,
        y: s.symXY[2 * i + 1]!,
        angle: s.symAngle[i]!,
        cell,
        elem: s.nodeCount + s.symLink[i]!,
      });
    }
    this.linkSpriteBuffer = sprites(ls);
    this.linkSpriteCount = ls.length;
    this.stateDirty = true;
  }

  setPaint(paint: Paint): void {
    this.paint = paint;
    this.stateDirty = true;
  }

  setFlags(node: Uint8Array, link: Uint8Array): void {
    this.nodeFlags = node;
    this.linkFlags = link;
    this.stateDirty = true;
  }

  setTheme(theme: Theme, atlas: Atlas | null): void {
    this.theme = theme;
    if (atlas) {
      this.atlasTexture.destroy();
      this.atlasTexture = this.device.createTexture({
        size: [atlas.bitmap.width, atlas.bitmap.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: atlas.bitmap }, { texture: this.atlasTexture }, [
        atlas.bitmap.width,
        atlas.bitmap.height,
      ]);
      this.atlasColumns = atlas.columns;
      this.group0 = null;
    }
  }

  setOptions(options: DrawOptions): void {
    this.options = options;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private writeState(s: Scene): void {
    const n = s.nodeCount + s.linkCount;
    const data = new Uint32Array(Math.max(4, n));
    const nc = this.paint?.nodeClass;
    const lc = this.paint?.linkClass;
    for (let i = 0; i < s.nodeCount; i++) data[i] = ((nc?.[i] ?? 0) & 15) | ((this.nodeFlags[i] ?? 0) << 8);
    for (let i = 0; i < s.linkCount; i++) {
      data[s.nodeCount + i] = ((lc?.[i] ?? 0) & 15) | ((this.linkFlags[i] ?? 0) << 8);
    }
    if (!this.stateBuffer || this.stateBuffer.size < data.byteLength) {
      this.stateBuffer?.destroy();
      this.stateBuffer = this.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.group0 = null;
    }
    this.device.queue.writeBuffer(this.stateBuffer, 0, data);
    this.stateDirty = false;
  }

  private writeUniforms(frame: Frame, s: Scene, t: Theme): void {
    const f = new Float32Array(this.uniformData);
    const u = new Uint32Array(this.uniformData);
    const c = frame.camera;
    f[0] = c.cx - s.originX;
    f[1] = c.cy - s.originY;
    f[2] = this.canvas.width;
    f[3] = this.canvas.height;
    f[4] = c.scale;
    f[5] = frame.dpr;
    f[6] = this.options.linkWidth;
    f[7] = this.options.nodeRadius;
    f[8] = this.options.symbolSize;
    f[9] = this.atlasColumns;
    u[10] = s.nodeCount;
    const put = (offset: number, hex: string) => {
      const [r, g, b] = rgb(hex);
      f.set([r, g, b, 1], offset);
    };
    put(12, t.selection);
    put(16, t.hover);
    const linkColors = [t.link, ...(this.paint?.linkLegend?.colors ?? [])];
    const nodeColors = [t.node, ...(this.paint?.nodeLegend?.colors ?? [])];
    for (let k = 0; k < 16; k++) {
      put(20 + 4 * k, linkColors[k] ?? t.link);
      put(84 + 4 * k, nodeColors[k] ?? t.node);
    }
    this.device.queue.writeBuffer(this.uniform, 0, this.uniformData);
  }

  render(frame: Frame): void {
    const s = this.scene;
    const t = this.theme;
    const clear = t?.background ?? '#ffffff';
    const [br, bg, bb] = clear === 'transparent' ? [0, 0, 0] : rgb(clear);
    const ba = clear === 'transparent' ? 0 : 1;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: br, g: bg, b: bb, a: ba },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    if (s && t && this.segBuffer) {
      if (this.stateDirty || !this.stateBuffer) this.writeState(s);
      this.writeUniforms(frame, s, t);
      this.group0 ??= this.device.createBindGroup({
        layout: this.layout0,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: this.stateBuffer! } },
          { binding: 2, resource: this.atlasTexture.createView() },
          { binding: 3, resource: this.sampler },
        ],
      });
      pass.setBindGroup(0, this.group0);
      const spacing = s.typicalLength * frame.camera.scale;
      const drawJunctions = spacing >= this.options.junctionMinSpacing;
      for (const p of [0, 1, 2]) {
        pass.setBindGroup(1, this.passGroups[p]);
        pass.setPipeline(this.segPipeline);
        pass.setVertexBuffer(0, this.segBuffer);
        pass.draw(6, s.segCount);
        if (drawJunctions && this.dotBuffer && this.dotCount > 0) {
          pass.setPipeline(this.dotPipeline);
          pass.setVertexBuffer(0, this.dotBuffer);
          pass.draw(6, this.dotCount);
        }
      }
      pass.setBindGroup(1, this.passGroups[0]);
      pass.setPipeline(this.spritePipeline);
      if (this.nodeSpriteCount > 0) {
        pass.setVertexBuffer(0, this.nodeSpriteBuffer);
        pass.draw(6, this.nodeSpriteCount);
      }
      if (spacing >= this.options.symbolSize && this.linkSpriteCount > 0) {
        pass.setVertexBuffer(0, this.linkSpriteBuffer);
        pass.draw(6, this.linkSpriteCount);
      }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const b of [
      this.segBuffer,
      this.dotBuffer,
      this.nodeSpriteBuffer,
      this.linkSpriteBuffer,
      this.stateBuffer,
    ]) {
      b?.destroy();
    }
    this.atlasTexture.destroy();
    this.device.destroy();
  }
}
