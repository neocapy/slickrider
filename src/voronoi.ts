import type { Vec3 } from "./math";
import type { WorldBounds } from "./scenemesh";

class SpatialGrid {
  private nx: number;
  private ny: number;
  private nz: number;
  private side: number;
  private halfX: number;
  private halfZ: number;
  private buckets: number[][];

  constructor(bounds: WorldBounds, targetBuckets: number) {
    const volume = bounds.sizeX * bounds.sizeY * bounds.sizeZ;
    this.side = Math.cbrt(volume / targetBuckets);
    this.nx = Math.ceil(bounds.sizeX / this.side);
    this.ny = Math.ceil(bounds.sizeY / this.side);
    this.nz = Math.ceil(bounds.sizeZ / this.side);
    this.halfX = bounds.sizeX / 2;
    this.halfZ = bounds.sizeZ / 2;
    this.buckets = new Array(this.nx * this.ny * this.nz);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  private bucketIndex(bx: number, by: number, bz: number): number {
    return (bz * this.ny + by) * this.nx + bx;
  }

  private toBucket(x: number, y: number, z: number): [number, number, number] {
    const bx = Math.min(Math.max(Math.floor((x + this.halfX) / this.side), 0), this.nx - 1);
    const by = Math.min(Math.max(Math.floor(y / this.side), 0), this.ny - 1);
    const bz = Math.min(Math.max(Math.floor((z + this.halfZ) / this.side), 0), this.nz - 1);
    return [bx, by, bz];
  }

  insert(point: Vec3, index: number): void {
    const [bx, by, bz] = this.toBucket(point[0], point[1], point[2]);
    this.buckets[this.bucketIndex(bx, by, bz)].push(index);
  }

  nearbyIndices(point: Vec3, radius: number): number[] {
    const [cx, cy, cz] = this.toBucket(point[0], point[1], point[2]);
    const r = Math.ceil(radius / this.side);
    const result: number[] = [];
    for (let dz = -r; dz <= r; dz++) {
      const bz = cz + dz;
      if (bz < 0 || bz >= this.nz) continue;
      for (let dy = -r; dy <= r; dy++) {
        const by = cy + dy;
        if (by < 0 || by >= this.ny) continue;
        for (let dx = -r; dx <= r; dx++) {
          const bx = cx + dx;
          if (bx < 0 || bx >= this.nx) continue;
          const bucket = this.buckets[this.bucketIndex(bx, by, bz)];
          for (let i = 0; i < bucket.length; i++) result.push(bucket[i]);
        }
      }
    }
    return result;
  }
}

export function generateVoronoiSites(
  bounds: WorldBounds,
  count: number,
  minDistance?: number,
): Float64Array {
  const volume = bounds.sizeX * bounds.sizeY * bounds.sizeZ;
  const dist = minDistance ?? Math.cbrt(volume / count) * 0.3;
  const dist2 = dist * dist;

  const halfX = bounds.sizeX / 2;
  const halfZ = bounds.sizeZ / 2;

  const grid = new SpatialGrid(bounds, 1000);
  const points = new Float64Array(count * 3);
  let accepted = 0;
  let totalAttempts = 0;
  const maxAttempts = count * 20;

  for (let attempt = 0; attempt < maxAttempts && accepted < count; attempt++) {
    totalAttempts++;
    const x = Math.random() * bounds.sizeX - halfX;
    const y = Math.random() * bounds.sizeY;
    const z = Math.random() * bounds.sizeZ - halfZ;

    const nearby = grid.nearbyIndices([x, y, z], dist);
    let tooClose = false;
    for (let i = 0; i < nearby.length; i++) {
      const j = nearby[i] * 3;
      const dx = points[j] - x;
      const dy = points[j + 1] - y;
      const dz = points[j + 2] - z;
      if (dx * dx + dy * dy + dz * dz < dist2) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const idx = accepted * 3;
    points[idx] = x;
    points[idx + 1] = y;
    points[idx + 2] = z;
    grid.insert([x, y, z], accepted);
    accepted++;
  }

  console.log(`Voronoi: accepted ${accepted}/${count} sites (${totalAttempts - accepted} rejected)`);
  return accepted === count ? points : points.slice(0, accepted * 3);
}
