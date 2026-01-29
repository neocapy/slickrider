const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

function showError(msg: string) {
  canvas.style.display = "none";
  errorEl.style.display = "flex";
  errorEl.textContent = msg;
}

class Game {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private backingWidth = 0;
  private backingHeight = 0;

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
      console.log(`Backing surface resized: ${w}x${h} (DPR: ${dpr})`);
    }
  }

  private onDprChange() {
    this.onResize();
    const next = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    next.addEventListener("change", this.onDprChange.bind(this), { once: true });
  }

  private start() {
    const frame = () => {
      this.onResize();
      this.update();
      this.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private update() {
  }

  private render() {
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.0, b: 0.1, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }
}

Game.create(canvas).catch((e: Error) => showError(e.message));
