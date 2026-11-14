/**
 * Pure-WebGPU 800x600 Retail Sprite, Rect, Scissor & `CxUni.fft` Bitmap-Font Renderer.
 *
 * Every pixel on screen — sprite sheets (`CDataI16` / `CDataI16Character`),
 * HLS team-colored bomber sheets, `nm.bik` Bink video frames, solid UI fills,
 * carets, and `CxUni.fft` 12x12 / 14x14 outline Traditional Chinese glyphs —
 * renders through a single instanced WebGPU pipeline on one native 800x600 canvas.
 */

import type { DecodedRgbaSheet } from "../data/assets.ts";
import { FftFont, type FftStyle } from "../data/fft.ts";

export interface DrawQuad {
  texture: GPUTexture;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  tint?: readonly [number, number, number, number];
  rotation?: number;
  flipX?: boolean;
}

const SHADER_SRC = /* wgsl */ `
struct Globals {
  resolution: vec2f,
  _pad: vec2f,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) dst: vec4f,
  @location(1) src: vec4f,
  @location(2) color: vec4f,
  @location(3) rot: f32,
) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];
  var local = vec2f(c.x * dst.z, c.y * dst.w) - vec2f(dst.z, dst.w) * 0.5;
  if (rot != 0.0) {
    let s = sin(rot);
    let co = cos(rot);
    local = vec2f(local.x * co - local.y * s, local.x * s + local.y * co);
  }
  let world = vec2f(dst.x + dst.z * 0.5, dst.y + dst.w * 0.5) + local;

  var out: VSOut;
  let ndc = vec2f(
    world.x / globals.resolution.x * 2.0 - 1.0,
    1.0 - world.y / globals.resolution.y * 2.0
  );
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = vec2f(mix(src.x, src.z, c.x), mix(src.y, src.w, c.y));
  out.color = color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let sample = textureSampleLevel(tex, samp, in.uv, 0.0);
  let outColor = sample * in.color;
  if (outColor.a <= 0.001) {
    discard;
  }
  return outColor;
}
`;

export interface DynamicTexture {
  readonly tex: GPUTexture;
  readonly width: number;
  readonly height: number;
  upload(rgba: Uint8Array): void;
  destroy(): void;
}

export interface RendererStats {
  quads: number;
  batchFlushes: number;
}

export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GlyphEntry {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  adv: number;
  drawOffsetX: number;
  drawOffsetY: number;
}

const ATLAS_SIZE = 1024;
const MAX_INSTANCES = 16384;
const FLOATS_PER_INST = 13;
const BYTES_PER_INST = FLOATS_PER_INST * 4; // 52

export class SpriteRenderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly canvas: HTMLCanvasElement;
  width: number;
  height: number;

  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly globals: GPUBuffer;
  private readonly globalBindGroup: GPUBindGroup;
  private readonly texBindGroupLayout: GPUBindGroupLayout;
  private readonly texBindGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  private readonly sheetTextures = new WeakMap<DecodedRgbaSheet, GPUTexture>();
  private readonly namedTextures = new Map<string, GPUTexture>();

  readonly whiteTexture: GPUTexture;

  // Dynamic GPU glyph atlas for CxUni.fft (styles 0..3)
  private font: FftFont | null = null;
  private readonly glyphAtlasTex: GPUTexture;
  private readonly glyphCache = new Map<number, GlyphEntry>();
  private atlasCursorX = 1;
  private atlasCursorY = 1;
  private atlasRowH = 0;
  private readonly glyphScratch = new Uint8Array(16 * 16 * 4);
  private uploadScratch = new Uint8Array(256 * 64);

  private readonly instanceData = new Float32Array(FLOATS_PER_INST * MAX_INSTANCES);
  private readonly instanceBuffer: GPUBuffer;
  private instanceCount = 0;
  private instanceCursor = 0;
  private currentTexture: GPUTexture | null = null;

  private pendingEncoder: GPUCommandEncoder | null = null;
  private pendingPass: GPURenderPassEncoder | null = null;
  private readonly clipStack: ClipRect[] = [];

  readonly stats: RendererStats = { quads: 0, batchFlushes: 0 };

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, width = 800, height = 600) {
    this.device = device;
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("WebGPU canvas context unavailable");
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format: this.format,
      alphaMode: "opaque",
    });

    const globalLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
      ],
    });
    this.texBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [globalLayout, this.texBindGroupLayout],
    });

    const module = device.createShaderModule({ code: SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: BYTES_PER_INST,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
              { shaderLocation: 3, offset: 48, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.sampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.globals = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.globalBindGroup = device.createBindGroup({
      layout: globalLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globals } },
        { binding: 1, resource: this.sampler },
      ],
    });

    this.instanceBuffer = device.createBuffer({
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.whiteTexture = this.createRgbaTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.glyphAtlasTex = device.createTexture({
      size: [ATLAS_SIZE, ATLAS_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Native 1x crisp 800x600 viewport
    this.resize(width, height);
  }

  setFont(font: FftFont): void {
    this.font = font;
  }

  getFont(): FftFont | null {
    return this.font;
  }

  /** Native 1x crisp 800x600 pixel backing store (zero CSS blur). */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.style.imageRendering = "pixelated";
    this.device.queue.writeBuffer(this.globals, 0, new Float32Array([width, height, 0, 0]));
  }

  private getBindGroup(tex: GPUTexture): GPUBindGroup {
    let bg = this.texBindGroups.get(tex);
    if (!bg) {
      bg = this.device.createBindGroup({
        layout: this.texBindGroupLayout,
        entries: [{ binding: 0, resource: tex.createView() }],
      });
      this.texBindGroups.set(tex, bg);
    }
    return bg;
  }

  /** Write RGBA8 pixels into a GPUTexture with WebGPU 256-byte row alignment. */
  writeRgbaToTexture(
    tex: GPUTexture,
    rgba: Uint8Array,
    width: number,
    height: number,
    dstX = 0,
    dstY = 0,
  ): void {
    if (width <= 0 || height <= 0) return;
    const srcRowBytes = width * 4;
    const alignedRowBytes = height > 1 ? (srcRowBytes + 255) & ~255 : srcRowBytes;
    if (alignedRowBytes === srcRowBytes) {
      this.device.queue.writeTexture(
        { texture: tex, origin: [dstX, dstY, 0] },
        rgba as unknown as BufferSource,
        { bytesPerRow: srcRowBytes, rowsPerImage: height },
        [width, height, 1],
      );
      return;
    }
    const total = alignedRowBytes * height;
    if (this.uploadScratch.byteLength < total) {
      this.uploadScratch = new Uint8Array(Math.max(total, this.uploadScratch.byteLength * 2));
    }
    for (let y = 0; y < height; y++) {
      this.uploadScratch.set(
        rgba.subarray(y * srcRowBytes, (y + 1) * srcRowBytes),
        y * alignedRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: tex, origin: [dstX, dstY, 0] },
      this.uploadScratch.subarray(0, total) as unknown as BufferSource,
      { bytesPerRow: alignedRowBytes, rowsPerImage: height },
      [width, height, 1],
    );
  }

  createRgbaTexture(width: number, height: number, rgba?: Uint8Array): GPUTexture {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const tex = this.device.createTexture({
      size: [w, h, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (rgba) {
      this.writeRgbaToTexture(tex, rgba, w, h);
    }
    return tex;
  }

  createTexture(bitmap: ImageBitmap): GPUTexture {
    const tex = this.device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex },
      [bitmap.width, bitmap.height],
    );
    return tex;
  }

  sheetTexture(sheet: DecodedRgbaSheet): GPUTexture {
    let tex = this.sheetTextures.get(sheet);
    if (!tex) {
      tex = this.createRgbaTexture(sheet.width, sheet.height, sheet.rgba);
      this.sheetTextures.set(sheet, tex);
    }
    return tex;
  }

  namedTexture(key: string, width: number, height: number, rgba: Uint8Array): GPUTexture {
    let tex = this.namedTextures.get(key);
    if (!tex || tex.width !== width || tex.height !== height) {
      tex?.destroy();
      tex = this.createRgbaTexture(width, height, rgba);
      this.namedTextures.set(key, tex);
    } else {
      this.writeRgbaToTexture(tex, rgba, width, height);
    }
    return tex;
  }

  createDynamicTexture(width: number, height: number): DynamicTexture {
    const tex = this.createRgbaTexture(width, height);
    return {
      tex,
      width,
      height,
      upload: (rgba: Uint8Array) => this.writeRgbaToTexture(tex, rgba, width, height),
      destroy: () => tex.destroy(),
    };
  }

  drawSprite(opts: {
    tex: GPUTexture;
    x: number;
    y: number;
    w: number;
    h: number;
    src?: readonly [number, number, number, number];
    tint?: readonly [number, number, number, number];
    flipX?: boolean;
    rotation?: number;
  }): void {
    const sx = opts.src ? opts.src[0] : 0;
    const sy = opts.src ? opts.src[1] : 0;
    const sw = opts.src ? opts.src[2] : opts.tex.width;
    const sh = opts.src ? opts.src[3] : opts.tex.height;
    this.draw({
      texture: opts.tex,
      sx,
      sy,
      sw,
      sh,
      dx: Math.round(opts.x),
      dy: Math.round(opts.y),
      dw: Math.round(opts.w),
      dh: Math.round(opts.h),
      tint: opts.tint,
      flipX: opts.flipX,
      rotation: opts.rotation,
    });
  }

  begin(clearColor: readonly [number, number, number, number] = [0, 0, 0, 1]): void {
    this.instanceCount = 0;
    this.instanceCursor = 0;
    this.currentTexture = null;
    this.clipStack.length = 0;
    this.stats.quads = 0;
    this.stats.batchFlushes = 0;

    this.pendingEncoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    this.pendingPass = this.pendingEncoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: clearColor[3] },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    this.pendingPass.setPipeline(this.pipeline);
    this.pendingPass.setBindGroup(0, this.globalBindGroup);
    this.pendingPass.setScissorRect(0, 0, this.width, this.height);
  }

  pushClip(x: number, y: number, w: number, h: number): void {
    this.flush();
    let cx = Math.round(x);
    let cy = Math.round(y);
    let cw = Math.round(w);
    let ch = Math.round(h);
    if (this.clipStack.length > 0) {
      const prev = this.clipStack[this.clipStack.length - 1]!;
      const nx0 = Math.max(cx, prev.x);
      const ny0 = Math.max(cy, prev.y);
      const nx1 = Math.min(cx + cw, prev.x + prev.w);
      const ny1 = Math.min(cy + ch, prev.y + prev.h);
      cx = nx0;
      cy = ny0;
      cw = Math.max(0, nx1 - nx0);
      ch = Math.max(0, ny1 - ny0);
    }
    cx = Math.max(0, Math.min(this.width, cx));
    cy = Math.max(0, Math.min(this.height, cy));
    cw = Math.max(0, Math.min(this.width - cx, cw));
    ch = Math.max(0, Math.min(this.height - cy, ch));
    this.clipStack.push({ x: cx, y: cy, w: cw, h: ch });
    if (this.pendingPass && cw > 0 && ch > 0) {
      this.pendingPass.setScissorRect(cx, cy, cw, ch);
    }
  }

  popClip(): void {
    this.flush();
    this.clipStack.pop();
    if (!this.pendingPass) return;
    if (this.clipStack.length === 0) {
      this.pendingPass.setScissorRect(0, 0, this.width, this.height);
    } else {
      const top = this.clipStack[this.clipStack.length - 1]!;
      if (top.w > 0 && top.h > 0) {
        this.pendingPass.setScissorRect(top.x, top.y, top.w, top.h);
      }
    }
  }

  private isCulledByZeroClip(): boolean {
    if (this.clipStack.length === 0) return false;
    const top = this.clipStack[this.clipStack.length - 1]!;
    return top.w <= 0 || top.h <= 0;
  }

  draw(q: DrawQuad): void {
    if (q.dw === 0 || q.dh === 0 || q.sw === 0 || q.sh === 0) return;
    if (this.isCulledByZeroClip()) return;

    if (!this.currentTexture || this.currentTexture !== q.texture) {
      this.flush();
      this.currentTexture = q.texture;
    }
    if (this.instanceCursor + this.instanceCount >= MAX_INSTANCES) {
      return;
    }

    const t = q.tint ?? [1, 1, 1, 1];
    const o = this.instanceCount * FLOATS_PER_INST;
    const d = this.instanceData;
    const u0 = q.sx / q.texture.width;
    const v0 = q.sy / q.texture.height;
    const u1 = (q.sx + q.sw) / q.texture.width;
    const v1 = (q.sy + q.sh) / q.texture.height;

    d[o] = q.dx;
    d[o + 1] = q.dy;
    d[o + 2] = q.dw;
    d[o + 3] = q.dh;
    d[o + 4] = q.flipX ? u1 : u0;
    d[o + 5] = v0;
    d[o + 6] = q.flipX ? u0 : u1;
    d[o + 7] = v1;
    d[o + 8] = t[0];
    d[o + 9] = t[1];
    d[o + 10] = t[2];
    d[o + 11] = t[3];
    d[o + 12] = q.rotation ?? 0;
    this.instanceCount++;
    this.stats.quads++;
  }

  /** Draw a frame from a DecodedRgbaSheet at `(x, y)`. If `usePivot`, draws at `(x - px, y - py)`. */
  drawSheet(
    sheet: DecodedRgbaSheet | null | undefined,
    frameIdx: number,
    x: number,
    y: number,
    opts?: {
      usePivot?: boolean;
      tint?: readonly [number, number, number, number];
      alpha?: number;
      w?: number;
      h?: number;
      flipX?: boolean;
    },
  ): void {
    if (!sheet || sheet.rects.length === 0) return;
    const idx = Math.max(0, Math.min(sheet.rects.length - 1, frameIdx | 0));
    const r = sheet.rects[idx]!;
    const sw = r.x1 - r.x0;
    const sh = r.y1 - r.y0;
    if (sw <= 0 || sh <= 0) return;
    const dx = opts?.usePivot ? Math.round(x - r.px) : Math.round(x);
    const dy = opts?.usePivot ? Math.round(y - r.py) : Math.round(y);
    const dw = opts?.w ?? sw;
    const dh = opts?.h ?? sh;
    let tint = opts?.tint;
    if (opts?.alpha !== undefined && !tint) {
      tint = [1, 1, 1, opts.alpha];
    } else if (opts?.alpha !== undefined && tint) {
      tint = [tint[0], tint[1], tint[2], tint[3] * opts.alpha];
    }
    this.draw({
      texture: this.sheetTexture(sheet),
      sx: r.x0,
      sy: r.y0,
      sw,
      sh,
      dx,
      dy,
      dw,
      dh,
      tint,
      flipX: opts?.flipX,
    });
  }

  /** Draw a solid color rectangle in pure WebGPU. */
  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: readonly [number, number, number, number],
  ): void {
    if (w <= 0 || h <= 0 || rgba[3] <= 0) return;
    this.draw({
      texture: this.whiteTexture,
      sx: 0,
      sy: 0,
      sw: 1,
      sh: 1,
      dx: Math.round(x),
      dy: Math.round(y),
      dw: Math.round(w),
      dh: Math.round(h),
      tint: rgba,
    });
  }

  /** Draw a crisp 1px (or `thickness` px) border rectangle in pure WebGPU. */
  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: readonly [number, number, number, number],
    thickness = 1,
  ): void {
    if (w <= 0 || h <= 0) return;
    this.fillRect(x, y, w, thickness, rgba);
    this.fillRect(x, y + h - thickness, w, thickness, rgba);
    this.fillRect(x, y + thickness, thickness, Math.max(0, h - thickness * 2), rgba);
    this.fillRect(x + w - thickness, y + thickness, thickness, Math.max(0, h - thickness * 2), rgba);
  }

  // --- Retail `CxUni.fft` GPU Bitmap/Outline Font Rendering ---

  private ensureGlyph(cp: number, style: FftStyle): GlyphEntry | null {
    if (!this.font) return null;
    const key = ((style & 3) << 17) | (cp & 0xffff);
    const cached = this.glyphCache.get(key);
    if (cached) return cached;

    const bmp = this.font.rasterize(cp, style);
    const sw = bmp.w;
    const sh = bmp.h;
    const ox = bmp.dx;
    const oy = bmp.dy;
    const adv = bmp.advance;
    const scratch = this.glyphScratch;
    scratch.fill(0, 0, sw * sh * 4);

    if (bmp.bgPixels) {
      for (let p = 0; p < sw * sh * 4; p += 4) {
        if (bmp.bgPixels[p + 3]! > 0) {
          scratch[p] = 0;
          scratch[p + 1] = 0;
          scratch[p + 2] = 0;
          scratch[p + 3] = 240;
        }
      }
    }
    for (let p = 0; p < sw * sh * 4; p += 4) {
      if (bmp.fgPixels[p + 3]! > 0) {
        scratch[p] = 255;
        scratch[p + 1] = 255;
        scratch[p + 2] = 255;
        scratch[p + 3] = 255;
      }
    }

    if (this.atlasCursorX + sw + 1 > ATLAS_SIZE) {
      this.atlasCursorX = 1;
      this.atlasCursorY += this.atlasRowH + 1;
      this.atlasRowH = 0;
    }
    if (this.atlasCursorY + sh + 1 > ATLAS_SIZE) {
      // Atlas full: reset cursor & cache
      this.glyphCache.clear();
      this.atlasCursorX = 1;
      this.atlasCursorY = 1;
      this.atlasRowH = 0;
    }

    const sx = this.atlasCursorX;
    const sy = this.atlasCursorY;
    this.atlasCursorX += sw + 1;
    if (sh > this.atlasRowH) this.atlasRowH = sh;

    this.writeRgbaToTexture(this.glyphAtlasTex, scratch, sw, sh, sx, sy);

    const entry: GlyphEntry = {
      sx,
      sy,
      sw,
      sh,
      adv,
      drawOffsetX: ox,
      drawOffsetY: oy,
    };
    this.glyphCache.set(key, entry);
    return entry;
  }

  measureText(text: string, style: FftStyle = 0): number {
    if (!this.font) return text.length * 7;
    return this.font.measureText(text, style);
  }

  /**
   * Draw `text` using the authentic `CxUni.fft` bitmap/outline font via WebGPU.
   * `style`: `0` plain, `1` drop-shadow, `2` 14x14 outline, `3` bold.
   */
  drawText(
    text: string,
    x: number,
    y: number,
    opts?: {
      color?: readonly [number, number, number, number];
      style?: FftStyle;
      align?: "left" | "center" | "right";
      maxWidth?: number;
      outlineColor?: readonly [number, number, number, number];
    },
  ): number {
    if (!text || !this.font) return 0;
    const style: FftStyle = opts?.outlineColor ? 2 : (opts?.style ?? 0);
    const color = opts?.color ?? [1, 1, 1, 1];
    let drawStr = text;
    if (opts?.maxWidth !== undefined && opts.maxWidth > 0) {
      while (drawStr.length > 0 && this.measureText(drawStr, style) > opts.maxWidth) {
        drawStr = drawStr.slice(0, -1);
      }
    }
    const totalW = this.measureText(drawStr, style);
    let penX = Math.round(x);
    if (opts?.align === "center") penX = Math.round(x - totalW * 0.5);
    else if (opts?.align === "right") penX = Math.round(x - totalW);
    const baseY = Math.round(y);

    for (let i = 0; i < drawStr.length; i++) {
      const cp = drawStr.charCodeAt(i);
      if (cp === 0x0d || cp === 0x0a) continue;
      if (cp === 0x20) {
        penX += this.font.advanceOf(0x20, style);
        continue;
      }
      const g = this.ensureGlyph(cp, style);
      if (!g) continue;
      this.draw({
        texture: this.glyphAtlasTex,
        sx: g.sx,
        sy: g.sy,
        sw: g.sw,
        sh: g.sh,
        dx: penX + g.drawOffsetX,
        dy: baseY + g.drawOffsetY,
        dw: g.sw,
        dh: g.sh,
        tint: color,
      });
      penX += g.adv;
    }
    return totalW;
  }

  /** Word/character-wrap `text` into lines of `<= maxWidth` pixels using `CxUni.fft` metrics. */
  wrapText(text: string, maxWidth: number, style: FftStyle = 0): string[] {
    if (!text) return [];
    const lines: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine) {
        lines.push("");
        continue;
      }
      let cur = "";
      let curW = 0;
      for (let i = 0; i < rawLine.length; i++) {
        const ch = rawLine[i]!;
        const w = this.font ? this.font.advanceOf(ch.charCodeAt(0), style) : 7;
        if (cur.length > 0 && curW + w > maxWidth) {
          lines.push(cur);
          cur = ch;
          curW = w;
        } else {
          cur += ch;
          curW += w;
        }
      }
      if (cur.length > 0) lines.push(cur);
    }
    return lines;
  }

  flush(): void {
    if (!this.pendingPass || !this.currentTexture || this.instanceCount === 0) return;
    const first = this.instanceCursor;
    const byteLen = this.instanceCount * BYTES_PER_INST;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      first * BYTES_PER_INST,
      this.instanceData.buffer,
      0,
      byteLen,
    );
    this.pendingPass.setBindGroup(1, this.getBindGroup(this.currentTexture));
    this.pendingPass.setVertexBuffer(0, this.instanceBuffer, first * BYTES_PER_INST, byteLen);
    this.pendingPass.draw(6, this.instanceCount);
    this.stats.batchFlushes++;
    this.instanceCursor += this.instanceCount;
    this.instanceCount = 0;
  }

  end(): void {
    this.flush();
    if (this.pendingPass) {
      this.pendingPass.end();
      this.pendingPass = null;
    }
    if (this.pendingEncoder) {
      this.device.queue.submit([this.pendingEncoder.finish()]);
      this.pendingEncoder = null;
    }
    this.instanceCursor = 0;
    this.currentTexture = null;
  }
}

export async function requestDevice(): Promise<GPUDevice> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU is not available in this browser");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("No WebGPU adapter found");
  }
  return adapter.requestDevice();
}
