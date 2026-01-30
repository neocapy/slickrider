import type { Vec3 } from "./math";
import type { WorldBounds } from "./scenemesh";

export class SpatialGrid {
  private nx: number;
  private ny: number;
  private nz: number;
  readonly side: number;
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

export type SiteGenMethod = "rejection" | "grid";

/**
 * Grid-based site generation: divides the world into a regular grid of
 * rectanguloids and places one point near the center of each cell,
 * jittered by `jitter` fraction of the cell dimensions.
 */
export function generateGridSites(
  bounds: WorldBounds,
  count: number,
  jitter = 0.2,
): Float64Array {
  const halfX = bounds.sizeX / 2;
  const halfZ = bounds.sizeZ / 2;
  const volume = bounds.sizeX * bounds.sizeY * bounds.sizeZ;
  const cellVol = volume / count;
  const cellSide = Math.cbrt(cellVol);

  const nx = Math.round(bounds.sizeX / cellSide);
  const ny = Math.round(bounds.sizeY / cellSide);
  const nz = Math.round(bounds.sizeZ / cellSide);
  const actual = nx * ny * nz;

  const dx = bounds.sizeX / nx;
  const dy = bounds.sizeY / ny;
  const dz = bounds.sizeZ / nz;

  const points = new Float64Array(actual * 3);
  let idx = 0;

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cx = (ix + 0.5) * dx - halfX;
        const cy = (iy + 0.5) * dy;
        const cz = (iz + 0.5) * dz - halfZ;

        points[idx]     = cx + (Math.random() * 2 - 1) * jitter * dx;
        points[idx + 1] = cy + (Math.random() * 2 - 1) * jitter * dy;
        points[idx + 2] = cz + (Math.random() * 2 - 1) * jitter * dz;
        idx += 3;
      }
    }
  }

  console.log(`Grid sites: ${actual} (${nx}×${ny}×${nz}), cell size ${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)}, jitter ${jitter}`);
  return points;
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

export function computeKNN(
  sites: Float64Array,
  bounds: WorldBounds,
  k: number,
): Uint32Array {
  const t0 = performance.now();
  const n = sites.length / 3;
  const grid = new SpatialGrid(bounds, 1000);

  // Populate grid with all sites
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    grid.insert([sites[j], sites[j + 1], sites[j + 2]], i);
  }

  const result = new Uint32Array(n * k);

  // Per-query reusable buffers
  const dists = new Float64Array(k);
  const indices = new Uint32Array(k);

  for (let qi = 0; qi < n; qi++) {
    const qx = sites[qi * 3];
    const qy = sites[qi * 3 + 1];
    const qz = sites[qi * 3 + 2];

    let found = 0;
    let maxDist = 0; // distance of the farthest in our k candidates
    let maxIdx = 0;  // index within candidates of the farthest

    // Expand search radius until we have k neighbors
    // Start with grid side length, double each time
    let radius = grid.side;
    for (let attempt = 0; attempt < 20; attempt++) {
      const nearby = grid.nearbyIndices([qx, qy, qz], radius);

      found = 0;
      maxDist = 0;
      maxIdx = 0;

      for (let ni = 0; ni < nearby.length; ni++) {
        const si = nearby[ni];
        if (si === qi) continue; // skip self

        const sj = si * 3;
        const dx = sites[sj] - qx;
        const dy = sites[sj + 1] - qy;
        const dz = sites[sj + 2] - qz;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (found < k) {
          dists[found] = d2;
          indices[found] = si;
          if (d2 > maxDist) { maxDist = d2; maxIdx = found; }
          found++;
        } else if (d2 < maxDist) {
          dists[maxIdx] = d2;
          indices[maxIdx] = si;
          // Recompute max
          maxDist = 0;
          maxIdx = 0;
          for (let m = 0; m < k; m++) {
            if (dists[m] > maxDist) { maxDist = dists[m]; maxIdx = m; }
          }
        }
      }

      if (found >= k) break;
      radius *= 2;
    }

    // Sort candidates by distance (nearest first)
    const pairs: { d: number; i: number }[] = [];
    for (let m = 0; m < found; m++) pairs.push({ d: dists[m], i: indices[m] });
    pairs.sort((a, b) => a.d - b.d);

    const offset = qi * k;
    for (let m = 0; m < k; m++) {
      result[offset + m] = m < pairs.length ? pairs[m].i : qi; // fallback to self if not enough
    }
  }

  const elapsed = performance.now() - t0;
  console.log(`k-NN: computed ${k} neighbors for ${n} sites in ${elapsed.toFixed(1)}ms`);
  return result;
}
