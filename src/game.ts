import { Input, Action } from "./input";
import { Renderer } from "./renderer";
import { Timing } from "./timing";

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

  private cameraYaw = 0;
  private cameraHeight = 2.5;
  private cameraDistance = 6;
  private readonly DISTANCES = [6, 10, 20];
  private cameraDistanceIndex = 0;

  // Use Game.create() to construct.
  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.renderer = new Renderer(device, format);
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

    const game = new Game(canvas, device, context, format);
    game.bindEvents();
    game.onResize();
    game.start();
    return game;
  }

  private bindEvents() {
    window.addEventListener("resize", this.onResize.bind(this));

    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", this.onDprChange.bind(this), { once: true });

    window.addEventListener("keydown", (e) => {
      if (e.code === "F2") {
        e.preventDefault();
        const el = this.debugOverlay;
        el.style.display = el.style.display === "none" ? "block" : "none";
      }
    });
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

  private start() {
    const frame = (timestamp: number) => {
      this.timing.update(timestamp);
      this.onResize();
      this.update();
      this.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private update() {
    this.input.update();
    const dt = this.timing.dt;

    this.cameraYaw += (this.input.value(Action.Right) - this.input.value(Action.Left)) * 1.5 * dt;
    this.cameraHeight += (this.input.value(Action.Up) - this.input.value(Action.Down)) * 3 * dt;

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
    }, aspect);
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
