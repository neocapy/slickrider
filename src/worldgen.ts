import { Material } from "./materials";
import { World } from "./world";

const WATER_LEVEL = 16;

interface Circle {
  cx: number;
  cz: number;
  radius: number;
  height: number;
}

function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (a - b) / k));
  return a * h + b * (1 - h) + k * h * (1 - h);
}

function buildHeightMap(): Float32Array {
  const w = World.SIZE_X;
  const h = World.SIZE_Z;
  const map = new Float32Array(w * h);

  // Define several overlapping plateau circles (in world coords)
  const circles: Circle[] = [
    { cx: 0,   cz: 0,   radius: 22, height: 45 },
    { cx: -12, cz: 10,  radius: 14, height: 55 },
    { cx: 10,  cz: -8,  radius: 16, height: 40 },
    { cx: -8,  cz: -14, radius: 12, height: 60 },
    { cx: 15,  cz: 12,  radius: 10, height: 50 },
  ];

  // For each column, compute height from smooth-unioned SDF circles
  for (let sz = 0; sz < h; sz++) {
    for (let sx = 0; sx < w; sx++) {
      const wx = sx - World.HALF_X;
      const wz = sz - World.HALF_Z;

      // Evaluate each circle as a height contribution
      // SDF-based: distance from circle edge, mapped to height
      let combined = 0;
      for (const c of circles) {
        const dx = wx - c.cx;
        const dz = wz - c.cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // Smooth falloff: full height at center, 0 at edge
        const t = Math.max(0, 1 - dist / c.radius);
        // Smooth cubic falloff
        const contribution = c.height * t * t * (3 - 2 * t);
        combined = smoothMax(combined, contribution, 8);
      }

      map[sz * w + sx] = Math.max(0, combined);
    }
  }

  // Erosion: iterative averaging to break up sharp edges
  const tmp = new Float32Array(w * h);
  for (let iter = 0; iter < 6; iter++) {
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let sum = map[z * w + x] * 4;
        let count = 4;
        if (x > 0)     { sum += map[z * w + (x - 1)]; count++; }
        if (x < w - 1) { sum += map[z * w + (x + 1)]; count++; }
        if (z > 0)     { sum += map[(z - 1) * w + x]; count++; }
        if (z < h - 1) { sum += map[(z + 1) * w + x]; count++; }
        tmp[z * w + x] = sum / count;
      }
    }
    map.set(tmp);
  }

  // Add some noise for irregularity
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const noise = hashF(x * 7 + 31, z * 13 + 47) * 3 - 1.5;
      const i = z * w + x;
      if (map[i] > 1) {
        map[i] = Math.max(1, map[i] + noise);
      }
    }
  }

  return map;
}

function hashF(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1013904223) | 0;
  h = ((h >> 13) ^ h) | 0;
  h = (h * 1274126177) | 0;
  return (((h >> 16) ^ h) & 0xffff) / 65535;
}

function placeHouses(world: World, heightMap: Float32Array): void {
  const w = World.SIZE_X;
  const candidates: { wx: number; wz: number; h: number }[] = [
    { wx: 5,   wz: 5,   h: 0 },
    { wx: -10, wz: 3,   h: 0 },
    { wx: 3,   wz: -12, h: 0 },
    { wx: -5,  wz: -8,  h: 0 },
  ];

  for (const c of candidates) {
    const sx = c.wx + World.HALF_X;
    const sz = c.wz + World.HALF_Z;
    const groundH = Math.floor(heightMap[sz * w + sx]);
    if (groundH <= WATER_LEVEL) continue;

    const bw = 4 + Math.floor(hashF(c.wx + 100, c.wz + 200) * 4); // 4-7
    const bd = 4 + Math.floor(hashF(c.wx + 300, c.wz + 400) * 4); // 4-7
    const bh = 3 + Math.floor(hashF(c.wx + 500, c.wz + 600) * 3); // 3-5

    for (let dy = 0; dy < bh; dy++) {
      for (let dz = 0; dz < bd; dz++) {
        for (let dx = 0; dx < bw; dx++) {
          world.set(c.wx + dx, groundH + 1 + dy, c.wz + dz, Material.Concrete);
        }
      }
    }
  }
}

export function generateWorld(world: World): void {
  const heightMap = buildHeightMap();
  const w = World.SIZE_X;

  // Fill terrain columns
  for (let sz = 0; sz < World.SIZE_Z; sz++) {
    for (let sx = 0; sx < World.SIZE_X; sx++) {
      const wx = sx - World.HALF_X;
      const wz = sz - World.HALF_Z;
      const h = Math.floor(heightMap[sz * w + sx]);

      if (h > 0) {
        // Stone from 0 to h-4
        for (let y = 0; y <= Math.max(0, h - 4); y++) {
          world.set(wx, y, wz, Material.Stone);
        }
        // Dirt from h-3 to h-1
        for (let y = Math.max(1, h - 3); y <= h - 1; y++) {
          world.set(wx, y, wz, Material.Dirt);
        }
        // Grass at h
        if (h >= 1) {
          world.set(wx, h, wz, Material.Grass);
        }
      }

      // Water fills air below water level
      for (let y = 0; y < WATER_LEVEL; y++) {
        if (world.get(wx, y, wz) === Material.Air) {
          world.set(wx, y, wz, Material.Water);
        }
      }
    }
  }

  // Place concrete houses on surface
  placeHouses(world, heightMap);
}
