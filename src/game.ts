import { Input, Action } from "./input";
import { Renderer } from "./renderer";
import { Timing } from "./timing";
import { buildSceneMesh, type WorldBounds } from "./scenemesh";
import { generateVoronoiSites, computeKNN } from "./voronoi";
import { buildVoronoiCells, extractVoronoiMesh } from "./convexcell";
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

  private cameraX = 0;
  private cameraY = 60;
  private cameraZ = 0;
  private cameraYaw = 0;
  private cameraPitch = 0;

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
    const sites = generateVoronoiSites(bounds, 16384);
    const k = 30;
    const knn = computeKNN(sites, bounds, k);
    const siteCount = sites.length / 3;

    const halfX = bounds.sizeX / 2;
    const halfZ = bounds.sizeZ / 2;

    // Build Voronoi cells
    const cells = buildVoronoiCells(
      sites, knn, k,
      -halfX, halfX, 0, bounds.sizeY, -halfZ, halfZ,
    );

    // Mark cells below water as solid ground
    const solid = new Array<boolean>(siteCount);
    const material = new Uint8Array(siteCount);
    for (let i = 0; i < siteCount; i++) {
      const sy = sites[i * 3 + 1];
      if (sy < waterHeight) {
        solid[i] = true;
        material[i] = Material.Stone;
      }
    }

    // Seed ~20 floating regions in the sky and flood-fill via knn adjacency
    const skyMaterials = [Material.Stone, Material.Dirt, Material.Grass, Material.Concrete];
    const rng = (seed: number) => {
      let s = seed;
      return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
    };
    const rand = rng(42);

    // Collect candidate sky cells (above water + margin)
    const skyCells: number[] = [];
    for (let i = 0; i < siteCount; i++) {
      if (sites[i * 3 + 1] > waterHeight + 10) skyCells.push(i);
    }

    for (let region = 0; region < 20; region++) {
      const seed = skyCells[Math.floor(rand() * skyCells.length)];
      if (solid[seed]) continue;
      const mat = skyMaterials[region % skyMaterials.length];
      const regionSize = 20 + Math.floor(rand() * 40); // 20-60 cells per region

      // BFS flood-fill using knn neighbors
      const queue = [seed];
      const visited = new Set<number>([seed]);
      let filled = 0;
      while (queue.length > 0 && filled < regionSize) {
        const cur = queue.shift()!;
        if (solid[cur]) continue;
        solid[cur] = true;
        material[cur] = mat;
        filled++;
        // Add knn neighbors
        for (let n = 0; n < k; n++) {
          const nb = knn[cur * k + n];
          if (!visited.has(nb) && !solid[nb]) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
    }

    // Extract mesh — use per-cell material
    const voronoiMesh = extractVoronoiMesh(cells, solid, material);
    console.log(`Voronoi mesh: ${voronoiMesh.vertices.length / 7} verts, ${voronoiMesh.indices.length / 3} tris`);

    const mesh = buildSceneMesh(bounds, waterHeight, null, null, voronoiMesh);
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

    const bounds: WorldBounds = { sizeX: 256, sizeY: 128, sizeZ: 96 };
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

    // Mouse look
    const MOUSE_SENSITIVITY = 0.003;
    const [mdx, mdy] = this.input.mouseDelta();
    this.cameraYaw -= mdx * MOUSE_SENSITIVITY;
    this.cameraPitch -= mdy * MOUSE_SENSITIVITY;
    const MAX_PITCH = (89 * Math.PI) / 180;
    this.cameraPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.cameraPitch));

    // Movement
    const MOVE_SPEED = 30;
    const forward = this.input.value(Action.Up) - this.input.value(Action.Down);
    const strafe = this.input.value(Action.Right) - this.input.value(Action.Left);
    const vertical = this.input.value(Action.DebugMoveUp) - this.input.value(Action.DebugMoveDown);

    const sinYaw = Math.sin(this.cameraYaw);
    const cosYaw = Math.cos(this.cameraYaw);

    this.cameraX += (-sinYaw * forward + cosYaw * strafe) * MOVE_SPEED * dt;
    this.cameraZ += (-cosYaw * forward - sinYaw * strafe) * MOVE_SPEED * dt;
    this.cameraY += vertical * MOVE_SPEED * dt;
  }

  private render() {
    const aspect = this.backingWidth / this.backingHeight || 1;
    this.renderer.render(this.context, {
      eye: [this.cameraX, this.cameraY, this.cameraZ],
      yaw: this.cameraYaw,
      pitch: this.cameraPitch,
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
