import { MATERIAL_COUNT } from "./materials";

const TEX_SIZE = 16;

type ColorFn = (x: number, y: number) => [number, number, number, number];

function makeLayer(fn: ColorFn): Uint8Array {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * TEX_SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1013904223) | 0;
  h = ((h >> 13) ^ h) | 0;
  h = (h * 1274126177) | 0;
  return ((h >> 16) ^ h) & 0xff;
}

const layerGenerators: ColorFn[] = [
  // Air - debug pink
  (_x, _y) => [255, 0, 255, 255],

  // Water - blue tones with slight variation
  (x, y) => {
    const v = hash(x, y);
    return [30 + (v & 15), 80 + (v & 31), 180 + (v & 31), 255];
  },

  // Stone - gray with noise
  (x, y) => {
    const v = hash(x, y);
    const base = 120 + (v & 31) - 16;
    const checker = ((x + y) & 1) * 8;
    return [base - checker, base - checker + 2, base - checker + 5, 255];
  },

  // Dirt - brown tones
  (x, y) => {
    const v = hash(x, y);
    return [100 + (v & 31), 70 + (v & 15), 40 + (v & 15), 255];
  },

  // Grass - green tones
  (x, y) => {
    const v = hash(x, y);
    return [50 + (v & 31), 130 + (v & 31), 40 + (v & 15), 255];
  },

  // Concrete - light gray, subtle noise
  (x, y) => {
    const v = hash(x, y);
    const base = 180 + (v & 15) - 8;
    return [base, base + 2, base + 4, 255];
  },

  // Frame - pitch black
  (_x, _y) => [0, 0, 0, 255],
];

export function createMaterialTextureArray(device: GPUDevice): {
  texture: GPUTexture;
  sampler: GPUSampler;
} {
  const texture = device.createTexture({
    size: [TEX_SIZE, TEX_SIZE, MATERIAL_COUNT],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  for (let layer = 0; layer < MATERIAL_COUNT; layer++) {
    const data = makeLayer(layerGenerators[layer]);
    device.queue.writeTexture(
      { texture, origin: [0, 0, layer] },
      data.buffer,
      { bytesPerRow: TEX_SIZE * 4, rowsPerImage: TEX_SIZE },
      [TEX_SIZE, TEX_SIZE, 1],
    );
  }

  const sampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
  });

  return { texture, sampler };
}
