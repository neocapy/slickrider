import { Input, Action } from "./input";
import { Renderer } from "./renderer";
import { Timing } from "./timing";
import { buildSceneMesh, type WorldBounds } from "./scenemesh";
import { generateVoronoiSites, computeKNN } from "./voronoi";
import { buildVoronoiCells, extractVoronoiMesh } from "./convexcell";
import { Material } from "./materials";
import { simplifyMesh } from "./meshopt";
import { fbm3D } from "./noise";

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
      sites, knn, k, bounds,
      -halfX, halfX, 0, bounds.sizeY, -halfZ, halfZ,
    );

    // --- Solid selection via 3D fBm noise ---
    const solid = new Array<boolean>(siteCount).fill(false);
    const material = new Uint8Array(siteCount);

    const noiseFreq = 0.025;
    const noiseThreshold = 0.15;

    for (let i = 0; i < siteCount; i++) {
      const sx = sites[i * 3];
      const sy = sites[i * 3 + 1];
      const sz = sites[i * 3 + 2];

      if (sy < waterHeight) {
        // Ground: always solid
        solid[i] = true;
      } else if (sy > waterHeight + 4) {
        // Sky: noise-based selection
        const n = fbm3D(sx * noiseFreq, sy * noiseFreq, sz * noiseFreq, 3, 2.0, 0.5);
        if (n > noiseThreshold) {
          solid[i] = true;
        }
      }
    }

    // --- Material assignment based on exposure ---
    // For each solid cell, check knn neighbors to determine exposure direction
    for (let i = 0; i < siteCount; i++) {
      if (!solid[i]) continue;

      const sy = sites[i * 3 + 1];

      // Ground cells are stone
      if (sy < waterHeight) {
        material[i] = Material.Stone;
        continue;
      }

      // Sky cells: classify by which directions have air neighbors
      let hasAirAbove = false;
      let hasAirBelow = false;
      let hasAirSide = false;

      for (let n = 0; n < k; n++) {
        const nb = knn[i * k + n];
        if (solid[nb]) continue;
        // This neighbor is air — check relative Y
        const dy = sites[nb * 3 + 1] - sy;
        const dx = sites[nb * 3] - sites[i * 3];
        const dz = sites[nb * 3 + 2] - sites[i * 3 + 2];
        const horizDist = Math.sqrt(dx * dx + dz * dz);

        if (dy > horizDist * 0.5) {
          hasAirAbove = true;
        } else if (dy < -horizDist * 0.5) {
          hasAirBelow = true;
        } else {
          hasAirSide = true;
        }
      }

      if (hasAirAbove) {
        material[i] = Material.Grass;
      } else if (hasAirSide && !hasAirBelow) {
        material[i] = Material.Dirt;
      } else if (hasAirBelow) {
        material[i] = Material.Stone;
      } else {
        // Fully interior
        material[i] = Material.Dirt;
      }
    }

    // Extract mesh — use per-cell material, then weld nearby vertices
    const rawMesh = extractVoronoiMesh(cells, solid, material);
    console.log(`Voronoi mesh: ${rawMesh.vertices.length / 7} verts, ${rawMesh.indices.length / 3} tris`);
    const voronoiMesh = simplifyMesh(rawMesh, 0.2, {
      subdivide: true,
      smooth: true,
      smoothIterations: 4,
      waterHeight,
    });

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
