/**
 * WebGPU sprite renderer.
 *
 * The original client blits 16 bpp sheets through GDI/DirectDraw; the web build
 * keeps the same model — a bag of textured quads with per-quad src/dst rect,
 * tint and alpha — but submits them through WebGPU.
 *
 * Colour note: sprite words are RGB565 big-endian where 0 is the colour key
 * (dword_62B548), so the decoded RGBA buffer already carries alpha and no
 * runtime colour conversion is needed.
 */

export interface DrawQuad {
  texture: GPUTexture;
  /** source rect in texels */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** destination rect in *logical* pixels (screen space, top-left origin) */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** rgba modulate (1,1,1,1 = unmodified) */
  tint?: [number, number, number, number];
  /** rotation in radians around the destination centre (UI art is never rotated) */
  rotation?: number;
}

/** Single instanced quad shader: 6 verts per instance, no vertex buffer. */
const SHADER_SRC = /* wgsl */ `
struct Globals {
  resolution: vec2f,
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var image: texture_2d<f32>;

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
  let a = rot;
  if (a != 0.0) {
    let s = sin(a);
    let co = cos(a);
    local = vec2f(local.x * co - local.y * s, local.x * s + local.y * co);
  }
  let world = vec2f(dst.x + dst.z * 0.5, dst.y + dst.w * 0.5) + local;

  var out: VSOut;
  // logical px -> clip space (y down)
  let ndc = vec2f(world.x / globals.resolution.x * 2.0 - 1.0,
                  1.0 - world.y / globals.resolution.y * 2.0);
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = vec2f(mix(src.x, src.z, c.x), mix(src.y, src.w, c.y));
  out.color = color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let tex = textureSample(image, samp, in.uv);
  // Premultiplied-ish: the art is stored with a colour key, alpha is binary.
  return tex * in.color;
}
`;

export interface RendererStats {
  quads: number;
  batchFlushes: number;
}

export class SpriteRenderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly globals: GPUBuffer;
  private readonly bindGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  private instanceData: Float32Array;
  private instanceBuffer: GPUBuffer;
  private instanceCount = 0;
  /** where the next batch starts inside the instance buffer */
  private instanceCursor = 0;
  private currentTexture: GPUTexture | null = null;
  private readonly canvas: HTMLCanvasElement;
  /** logical resolution (the client runs at a fixed 800x600-ish root) */
  width: number;
  height: number;
  private dpr: number;
  private pendingEncoder: GPUCommandEncoder | null = null;
  private pendingPass: GPURenderPassEncoder | null = null;
  readonly stats: RendererStats = { quads: 0, batchFlushes: 0 };

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, width: number, height: number) {
    this.device = device;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas context unavailable');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    const module = device.createShaderModule({ code: SHADER_SRC });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 52,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' }, // dst
              { shaderLocation: 1, offset: 16, format: 'float32x4' }, // src
              { shaderLocation: 2, offset: 32, format: 'float32x4' }, // color
              { shaderLocation: 3, offset: 48, format: 'float32' }, // rotation
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.globals = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // 13 floats per instance: dst(4) src(4) colour(4) rotation(1)
    this.instanceData = new Float32Array(13 * 4096);
    this.instanceBuffer = device.createBuffer({
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.resize(width, height);
  }

  /** fixed logical size; backing store follows devicePixelRatio */
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.device.queue.writeBuffer(
      this.globals,
      0,
      new Float32Array([width, height, 0, 0]),
    );
  }

  /** Upload a decoded sheet as a GPU texture. */
  createTexture(bitmap: ImageBitmap): GPUTexture {
    const tex = this.device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex },
      [bitmap.width, bitmap.height],
    );
    return tex;
  }

  begin(clear = true) {
    this.instanceCount = 0;
    this.instanceCursor = 0;
    this.currentTexture = null;
    if (clear) {
      this.stats.quads = 0;
      this.stats.batchFlushes = 0;
    }
    // Open the pass here, not on the first flush: a frame that draws nothing
    // still has to clear the swapchain, otherwise the previous frame stays.
    this.pendingEncoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    this.pendingPass = this.pendingEncoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: clear ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
    });
    this.pendingPass.setPipeline(this.pipeline);
    this.pendingPass.setVertexBuffer(0, this.instanceBuffer);
  }

  draw(q: DrawQuad) {
    if ((this.instanceCursor + this.instanceCount + 1) * 52 > this.instanceBuffer.size) {
      // Submit the full buffer before reusing it, preserving the current frame.
      this.end();
      this.begin(false);
    } else if ((this.instanceCount + 1) * 13 > this.instanceData.length) {
      this.flush();
    }
    if (this.currentTexture !== q.texture) {
      this.flush();
      this.currentTexture = q.texture;
    }
    const t = q.tint ?? [1, 1, 1, 1];
    const o = this.instanceCount * 13;
    const d = this.instanceData;
    d[o] = q.dx;
    d[o + 1] = q.dy;
    d[o + 2] = q.dw;
    d[o + 3] = q.dh;
    d[o + 4] = q.sx / q.texture.width;
    d[o + 5] = q.sy / q.texture.height;
    d[o + 6] = (q.sx + q.sw) / q.texture.width;
    d[o + 7] = (q.sy + q.sh) / q.texture.height;
    d[o + 8] = t[0];
    d[o + 9] = t[1];
    d[o + 10] = t[2];
    d[o + 11] = t[3];
    d[o + 12] = q.rotation ?? 0;
    this.instanceCount++;
    this.stats.quads++;
  }

  private overlay: (() => void) | null = null;

  /** Queue a callback that runs after the sprite pass (text, HUD, …). */
  onAfter(quads: () => void) {
    this.overlay = quads;
  }

  flush() {
    if (!this.pendingPass || this.instanceCount === 0) return;
    // Each batch keeps its own slice of the instance buffer: a render pass
    // reads vertex buffers when it executes, so overwriting the same slice
    // between draws would make earlier batches read the later data.
    const first = this.instanceCursor;
    const bytes = this.instanceCount * 13 * 4;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      first * 52,
      this.instanceData.buffer,
      0,
      bytes,
    );
    if (!this.currentTexture) throw new Error('Sprite batch has no texture');
    let bindGroup = this.bindGroups.get(this.currentTexture);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.globals } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.currentTexture.createView() },
        ],
      });
      this.bindGroups.set(this.currentTexture, bindGroup);
    }
    this.pendingPass.setBindGroup(0, bindGroup);
    this.pendingPass.setVertexBuffer(0, this.instanceBuffer, first * 52, this.instanceCount * 52);
    this.pendingPass.draw(6, this.instanceCount);
    this.stats.batchFlushes++;
    this.instanceCursor += this.instanceCount;
    this.instanceCount = 0;
  }

  /** Finish the frame (flushes the last batch and submits). */
  end() {
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
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  return adapter.requestDevice();
}
