import { Input, Action } from "./input";
import { Renderer } from "./renderer";
import { Timing } from "./timing";
import { buildSceneMesh, type WorldBounds } from "./scenemesh";
import { generateVoronoiSites, computeKNN } from "./voronoi";
import { Material } from "./materials";

export class Game {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private backingWidth = 0;
  private backingHeight = 0;

  private timing = new Timing();
  private input = new Input();
  private debugOverlay = document.getElementById("debug-overlay")!;
  private renderer: Renderer;

  private rafId = 0;
  private boundOnResize = this.onResize.bind(this);
  private wireframeMode = false;
  private boundOnFKeys = (e: KeyboardEvent) => {
    if (e.code === "F2") {
      e.preventDefault();
      const el = this.debugOverlay;
      el.style.display = el.style.display === "none" ? "block" : "none";
    } else if (e.code === "F3") {
      e.preventDefault();
      this.wireframeMode = !this.wireframeMode;
    }
  };

  private cameraYaw = 0;
  private cameraHeight = 60;
  private cameraDistance = 120;
  private readonly DISTANCES = [80, 120, 200];
  private cameraDistanceIndex = 1;

  private bounds: WorldBounds;
  private waterHeight: number;

  // Use Game.create() to construct.
  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    bounds: WorldBounds,
    waterHeight: number,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.bounds = bounds;
    this.waterHeight = waterHeight;
    const sites = generateVoronoiSites(bounds, 4000);
    const knn = computeKNN(sites, bounds, 10);
    const siteCount = sites.length / 3;
    const k = 10;

    // Debug visualization: pick 4 probes, color their neighborhoods
    const siteColors = new Uint8Array(siteCount).fill(Material.Frame);
    const probeCount = 4;
    const neighborMats = [Material.Stone, Material.Dirt, Material.Grass, Material.Concrete];
    for (let p = 0; p < probeCount; p++) {
      const probeIdx = Math.floor(Math.random() * siteCount);
      siteColors[probeIdx] = Material.Air; // pink probe
      for (let ni = 0; ni < k; ni++) {
        siteColors[knn[probeIdx * k + ni]] = neighborMats[p];
      }
    }

    const mesh = buildSceneMesh(bounds, waterHeight, sites, siteColors);
    this.renderer = new Renderer(device, format, mesh);
  }

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported in this browser. Please use a recent version of Chrome.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Failed to get a WebGPU adapter. Your GPU may not be supported.");
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu")!;
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({ device, format, alphaMode: "opaque" });

    const bounds: WorldBounds = { sizeX: 64, sizeY: 128, sizeZ: 64 };
    const waterHeight = 16;

    const game = new Game(canvas, device, context, format, bounds, waterHeight);
    game.bindEvents();
    game.onResize();
    game.start();
    return game;
  }

  private bindEvents() {
    window.addEventListener("resize", this.boundOnResize);

    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", this.onDprChange.bind(this), { once: true });

    window.addEventListener("keydown", this.boundOnFKeys);
  }

  private onResize() {
    const dpr = window.devicePixelRatio;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);

    if (w !== this.backingWidth || h !== this.backingHeight) {
      this.backingWidth = w;
      this.backingHeight = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer.resize(w, h);
      console.log(`Backing surface resized: ${w}x${h} (DPR: ${dpr})`);
    }
  }

  private onDprChange() {
    this.onResize();
    const next = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    next.addEventListener("change", this.onDprChange.bind(this), { once: true });
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.boundOnResize);
    window.removeEventListener("keydown", this.boundOnFKeys);
    this.input.destroy();
    this.renderer.destroy();
  }

  private start() {
    const frame = (timestamp: number) => {
      this.timing.update(timestamp);
      this.onResize();
      this.update();
      this.render();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private update() {
    this.input.update();
    const dt = this.timing.dt;

    this.cameraYaw += (this.input.value(Action.Right) - this.input.value(Action.Left)) * 1.5 * dt;
    this.cameraHeight += (this.input.value(Action.Up) - this.input.value(Action.Down)) * 30 * dt;

    if (this.input.justPressed(Action.Jump)) {
      this.cameraDistanceIndex = (this.cameraDistanceIndex + 1) % this.DISTANCES.length;
      this.cameraDistance = this.DISTANCES[this.cameraDistanceIndex];
    }
  }

  private render() {
    const aspect = this.backingWidth / this.backingHeight || 1;
    this.renderer.render(this.context, {
      yaw: this.cameraYaw,
      height: this.cameraHeight,
      distance: this.cameraDistance,
    }, aspect, this.wireframeMode);
    this.renderDebugOverlay();
  }

  private renderDebugOverlay() {
    if (this.debugOverlay.style.display === "none") return;

    const s = this.timing.stats();
    const fmt = (v: number) => (v * 1000).toFixed(2).padStart(7);
    const fmtFps = (v: number) => (v > 0 ? (1 / v).toFixed(1) : "---");

    this.debugOverlay.textContent = [
      `dt     ${fmt(this.timing.dt)} ms  (${fmtFps(this.timing.dt)} fps)`,
      `med    ${fmt(s.median)} ms  (${fmtFps(s.median)} fps)`,
      `p10    ${fmt(s.p10)} ms`,
      `p90    ${fmt(s.p90)} ms`,
      `min    ${fmt(s.min)} ms`,
      `max    ${fmt(s.max)} ms`,
      `total  ${this.timing.totalTime.toFixed(1)} s`,
    ].join("\n");
  }
}
