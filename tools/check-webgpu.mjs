/**
 * Browser regression for the actual WebGPU pipeline and login screen.
 * Start the dev server first and set CHROMIUM_PATH if Chromium is not installed
 * in a standard Playwright location. WEBGPU_SWIFTSHADER=1 enables software Vulkan.
 * The server must serve this checkout's freshly built public/build/ directory.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const url = process.env.BNB_URL ?? 'http://127.0.0.1:3000';
execFileSync('bun', ['build', 'src/main.ts', 'src/gfx/renderer.ts', '--outdir', 'public/build', '--target', 'browser'], { stdio: 'inherit' });
const flags = ['--enable-unsafe-webgpu'];
if (process.env.WEBGPU_SWIFTSHADER === '1') {
  flags.push('--use-gl=angle', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan,UseSkiaRenderer', '--enable-unsafe-swiftshader');
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: flags,
});
try {
  // This page uses a real WebGPU device but an offscreen render target so it
  // can read back exact pixels. It tests the real renderer, including texture
  // changes and wrapping the 4096-instance buffer in the middle of a frame.
  const gpuPage = await browser.newPage({ deviceScaleFactor: 1 });
  await gpuPage.route(`${url}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GPU test</title>' }));
  await gpuPage.goto(`${url}/`);
  const result = await gpuPage.evaluate(async () => {
    const { SpriteRenderer } = await import('/build/gfx/renderer.js');
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const target = device.createTexture({ size: [8, 8], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const canvas = {
      width: 8, height: 8, style: {},
      getContext: () => ({ configure() {}, getCurrentTexture: () => target }),
    };
    const renderer = new SpriteRenderer(device, canvas, 8, 8);
    async function makeTexture(colour) {
      const c = new OffscreenCanvas(1, 1);
      const ctx = c.getContext('2d');
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return renderer.createTexture(await createImageBitmap(c));
    }
    const red = await makeTexture('red');
    const green = await makeTexture('lime');
    const blue = await makeTexture('blue');
    const draw = (texture, x, y, w, h) => renderer.draw({ texture, sx: 0, sy: 0, sw: 1, sh: 1, dx: x, dy: y, dw: w, dh: h });
    renderer.begin();
    // 4096 draws exhaust the instance buffer; the next draw must load, not
    // clear, the preceding red pixels and must bind the new green texture.
    for (let i = 0; i < 4096; i++) draw(red, 0, 0, 4, 8);
    draw(green, 4, 0, 4, 8);
    draw(blue, 2, 2, 2, 2);
    renderer.end();
    const buffer = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [8, 8]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange());
    const pixel = (x, y) => {
      const p = Array.from(data.slice(y * 256 + x * 4, y * 256 + x * 4 + 4));
      return format.startsWith('bgra') ? [p[2], p[1], p[0], p[3]] : p;
    };
    const pixels = [pixel(0, 0), pixel(7, 0), pixel(2, 2)];
    buffer.unmap();
    const error = await device.popErrorScope();
    return { pixels, error: error?.message ?? null };
  });
  if (result.error || JSON.stringify(result.pixels) !== JSON.stringify([[255,0,0,255], [0,255,0,255], [0,0,255,255]])) {
    throw new Error(`Renderer pixel/validation failure: ${JSON.stringify(result)}`);
  }
  console.log('ok: WebGPU shader, textures, draw order and 4096-instance rollover');
  await gpuPage.close();

  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${url}/`);
  await page.waitForFunction(() => document.querySelector('#log')?.textContent?.includes('handshake:') && document.querySelector('#log')?.textContent?.includes('login stage ready'), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const log = await page.locator('#log').innerText();
  if (/WebGPU error|WebGPU device lost|Render error/i.test(log)) throw new Error(log);
  const screen = page.locator('#screen');
  const pixels = PNG.sync.read(await screen.screenshot());
  let colourful = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b] = pixels.data.subarray(i, i + 3);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40 && Math.max(r, g, b) > 80) colourful++;
  }
  if (colourful < 800 * 600 * 0.1) throw new Error(`Login canvas is blank or nearly blank (${colourful} colourful pixels)`);
  const bounds = await page.evaluate(() => {
    const canvas = document.querySelector('#screen').getBoundingClientRect();
    const overlay = document.querySelector('#screen + canvas').getBoundingClientRect();
    return [canvas.x, canvas.y, canvas.width, canvas.height, overlay.x, overlay.y, overlay.width, overlay.height];
  });
  if (bounds.slice(0, 4).some((v, i) => v !== bounds[i + 4])) throw new Error(`Overlay misaligned: ${bounds}`);
  console.log(`ok: login canvas visible (${colourful} colourful pixels), overlay aligned`);
  await screen.click({ position: { x: 410, y: 500 } });
  await page.keyboard.type('gpu-test');
  await page.keyboard.press('Tab');
  await page.keyboard.type('test');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#log')?.textContent?.includes('server stage ready'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const after = await page.locator('#log').innerText();
  if (/WebGPU error|WebGPU device lost|Render error/i.test(after) || errors.length) throw new Error(`Browser errors: ${errors.join('; ')}\n${after}`);
  const serverPixels = PNG.sync.read(await screen.screenshot());
  let changed = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (Math.abs(pixels.data[i] - serverPixels.data[i]) + Math.abs(pixels.data[i + 1] - serverPixels.data[i + 1]) + Math.abs(pixels.data[i + 2] - serverPixels.data[i + 2]) > 30) changed++;
  }
  if (changed < 10000) throw new Error(`Server selection did not visibly render (${changed} pixels changed)`);
  console.log('ok: login interaction visibly reaches server selection without browser or WebGPU errors');
  await page.close();
} finally {
  await browser.close();
}
