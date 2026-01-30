/**
 * Mesh post-processing: edge-collapse simplification, Loop subdivision,
 * Taubin smoothing, and material repainting.
 * Vertex format: 7 floats per vertex (x, y, z, nx, ny, nz, mat).
 * Maintains watertight topology by only collapsing edges where the
 * local neighborhood stays manifold.
 */

import { Material } from "./materials";

const VERTEX_FLOATS = 7;

interface RawMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Deduplicate vertices at the same position (within epsilon).
 * Produces a proper shared-vertex indexed mesh from a "fat" per-face mesh.
 * Keeps the normal/material of the first occurrence.
 */
function deduplicateVertices(mesh: RawMesh, epsilon = 1e-4): RawMesh {
  const vertCount = mesh.vertices.length / VERTEX_FLOATS;
  const remap = new Int32Array(vertCount);
  const outVerts: number[] = [];
  let outCount = 0;
  const eps2 = epsilon * epsilon;

  // Spatial hash for fast lookup
  const cellSize = Math.max(epsilon * 10, 0.01);
  const buckets = new Map<string, number[]>();

  function hashKey(x: number, y: number, z: number): string {
    const bx = Math.floor(x / cellSize);
    const by = Math.floor(y / cellSize);
    const bz = Math.floor(z / cellSize);
    return `${bx},${by},${bz}`;
  }

  for (let i = 0; i < vertCount; i++) {
    const o = i * VERTEX_FLOATS;
    const x = mesh.vertices[o], y = mesh.vertices[o + 1], z = mesh.vertices[o + 2];

    // Search nearby buckets
    const bx = Math.floor(x / cellSize);
    const by = Math.floor(y / cellSize);
    const bz = Math.floor(z / cellSize);

    let found = -1;
    outer: for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${bx + dx},${by + dy},${bz + dz}`;
          const bucket = buckets.get(key);
          if (!bucket) continue;
          for (const ni of bucket) {
            const no = ni * VERTEX_FLOATS;
            const ex = outVerts[no] - x;
            const ey = outVerts[no + 1] - y;
            const ez = outVerts[no + 2] - z;
            if (ex * ex + ey * ey + ez * ez < eps2) {
              found = ni;
              break outer;
            }
          }
        }
      }
    }

    if (found >= 0) {
      remap[i] = found;
    } else {
      const ni = outCount++;
      remap[i] = ni;
      for (let f = 0; f < VERTEX_FLOATS; f++) {
        outVerts.push(mesh.vertices[o + f]);
      }
      const key = hashKey(x, y, z);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      bucket.push(ni);
    }
  }

  const outIndices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    outIndices[i] = remap[mesh.indices[i]];
  }

  console.log(`Dedup: ${vertCount} -> ${outCount} verts`);
  return { vertices: new Float32Array(outVerts), indices: outIndices };
}

// ---------------------------------------------------------------------------
// Loop subdivision
// ---------------------------------------------------------------------------

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

interface EdgeInfo {
  v0: number;
  v1: number;
  midIdx: number;           // filled in during midpoint creation
  tris: number[];           // adjacent triangle indices (1 = boundary, 2 = interior)
}

/**
 * One iteration of Loop subdivision. Each triangle becomes 4; vertex count
 * roughly doubles (one new vertex per edge). Boundary edges and vertices
 * use the standard boundary stencils.
 */
function loopSubdivide(mesh: RawMesh): RawMesh {
  const t0 = performance.now();
  const vertCount = mesh.vertices.length / VERTEX_FLOATS;
  const triCount = mesh.indices.length / 3;

  // --- Build edge map and per-vertex neighbor / boundary info ---
  const edges = new Map<string, EdgeInfo>();
  // Per-vertex: set of neighbor vertex indices
  const neighbors: Set<number>[] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) neighbors[i] = new Set();

  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3];
    const i1 = mesh.indices[t * 3 + 1];
    const i2 = mesh.indices[t * 3 + 2];
    const verts = [i0, i1, i2];
    for (let e = 0; e < 3; e++) {
      const a = verts[e], b = verts[(e + 1) % 3];
      neighbors[a].add(b);
      neighbors[b].add(a);
      const key = edgeKey(a, b);
      let info = edges.get(key);
      if (!info) {
        info = { v0: Math.min(a, b), v1: Math.max(a, b), midIdx: -1, tris: [] };
        edges.set(key, info);
      }
      info.tris.push(t);
    }
  }

  // Identify boundary vertices (any vertex on an edge with only 1 adjacent triangle)
  const isBoundary = new Uint8Array(vertCount);
  for (const info of edges.values()) {
    if (info.tris.length === 1) {
      isBoundary[info.v0] = 1;
      isBoundary[info.v1] = 1;
    }
  }

  // --- Allocate output vertex array ---
  // Original verts (updated positions) + one new vert per edge
  const newVertCount = vertCount + edges.size;
  const outVerts = new Float32Array(newVertCount * VERTEX_FLOATS);

  // Copy original positions (will be overwritten with Loop weights)
  outVerts.set(mesh.vertices);

  // --- Compute new positions for original vertices ---
  for (let v = 0; v < vertCount; v++) {
    const o = v * VERTEX_FLOATS;
    const vx = mesh.vertices[o], vy = mesh.vertices[o + 1], vz = mesh.vertices[o + 2];

    if (isBoundary[v]) {
      // Boundary vertex: average with the two boundary neighbors
      // Find boundary neighbors (neighbors connected via boundary edge)
      const bNeighbors: number[] = [];
      for (const nb of neighbors[v]) {
        const key = edgeKey(v, nb);
        const info = edges.get(key)!;
        if (info.tris.length === 1) bNeighbors.push(nb);
      }
      if (bNeighbors.length === 2) {
        const [n0, n1] = bNeighbors;
        const o0 = n0 * VERTEX_FLOATS, o1 = n1 * VERTEX_FLOATS;
        outVerts[o]     = (mesh.vertices[o0] + 6 * vx + mesh.vertices[o1]) / 8;
        outVerts[o + 1] = (mesh.vertices[o0 + 1] + 6 * vy + mesh.vertices[o1 + 1]) / 8;
        outVerts[o + 2] = (mesh.vertices[o0 + 2] + 6 * vz + mesh.vertices[o1 + 2]) / 8;
      }
      // else: irregular boundary, keep position
    } else {
      // Interior vertex: Loop beta formula
      const n = neighbors[v].size;
      if (n < 3) continue; // degenerate, keep position
      const beta = n === 3 ? 3 / 16
                 : (1 / n) * (5 / 8 - Math.pow(3 / 8 + (1 / 4) * Math.cos(2 * Math.PI / n), 2));
      let sx = 0, sy = 0, sz = 0;
      for (const nb of neighbors[v]) {
        const no = nb * VERTEX_FLOATS;
        sx += mesh.vertices[no];
        sy += mesh.vertices[no + 1];
        sz += mesh.vertices[no + 2];
      }
      outVerts[o]     = (1 - n * beta) * vx + beta * sx;
      outVerts[o + 1] = (1 - n * beta) * vy + beta * sy;
      outVerts[o + 2] = (1 - n * beta) * vz + beta * sz;
    }
    // normals/material: keep from original (will be recalculated later)
  }

  // --- Create edge midpoint vertices ---
  let nextIdx = vertCount;
  for (const info of edges.values()) {
    const midIdx = nextIdx++;
    info.midIdx = midIdx;
    const o0 = info.v0 * VERTEX_FLOATS, o1 = info.v1 * VERTEX_FLOATS;
    const mo = midIdx * VERTEX_FLOATS;

    if (info.tris.length === 2) {
      // Interior edge: Loop weights 3/8 + 3/8 + 1/8 + 1/8
      // Find the two opposite vertices
      const t0 = info.tris[0], t1 = info.tris[1];
      let opp0 = -1, opp1 = -1;
      for (let c = 0; c < 3; c++) {
        const vi = mesh.indices[t0 * 3 + c];
        if (vi !== info.v0 && vi !== info.v1) { opp0 = vi; break; }
      }
      for (let c = 0; c < 3; c++) {
        const vi = mesh.indices[t1 * 3 + c];
        if (vi !== info.v0 && vi !== info.v1) { opp1 = vi; break; }
      }
      if (opp0 >= 0 && opp1 >= 0) {
        const oo0 = opp0 * VERTEX_FLOATS, oo1 = opp1 * VERTEX_FLOATS;
        for (let f = 0; f < 3; f++) {
          outVerts[mo + f] = (3 * mesh.vertices[o0 + f] + 3 * mesh.vertices[o1 + f]
                            + mesh.vertices[oo0 + f] + mesh.vertices[oo1 + f]) / 8;
        }
      } else {
        // Fallback: midpoint
        for (let f = 0; f < 3; f++) {
          outVerts[mo + f] = (mesh.vertices[o0 + f] + mesh.vertices[o1 + f]) / 2;
        }
      }
    } else {
      // Boundary edge: simple midpoint
      for (let f = 0; f < 3; f++) {
        outVerts[mo + f] = (mesh.vertices[o0 + f] + mesh.vertices[o1 + f]) / 2;
      }
    }
    // Normal: average (placeholder, recalculated later)
    for (let f = 3; f < 6; f++) {
      outVerts[mo + f] = (mesh.vertices[o0 + f] + mesh.vertices[o1 + f]) / 2;
    }
    // Material: take from v0 (will be repainted)
    outVerts[mo + 6] = mesh.vertices[o0 + 6];
  }

  // --- Generate 4 sub-triangles per original triangle ---
  const outIndices = new Uint32Array(triCount * 4 * 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3];
    const i1 = mesh.indices[t * 3 + 1];
    const i2 = mesh.indices[t * 3 + 2];

    const m01 = edges.get(edgeKey(i0, i1))!.midIdx;
    const m12 = edges.get(edgeKey(i1, i2))!.midIdx;
    const m20 = edges.get(edgeKey(i2, i0))!.midIdx;

    const base = t * 12;
    // Corner triangles
    outIndices[base]     = i0;  outIndices[base + 1] = m01; outIndices[base + 2] = m20;
    outIndices[base + 3] = i1;  outIndices[base + 4] = m12; outIndices[base + 5] = m01;
    outIndices[base + 6] = i2;  outIndices[base + 7] = m20; outIndices[base + 8] = m12;
    // Center triangle
    outIndices[base + 9] = m01; outIndices[base + 10] = m12; outIndices[base + 11] = m20;
  }

  const elapsed = performance.now() - t0;
  console.log(`Loop subdivide: ${vertCount} -> ${newVertCount} verts, ${triCount} -> ${triCount * 4} tris in ${elapsed.toFixed(0)}ms`);

  return { vertices: outVerts, indices: outIndices };
}

// ---------------------------------------------------------------------------
// Taubin smoothing
// ---------------------------------------------------------------------------

/**
 * Taubin λ|μ smoothing: alternating positive/negative Laplacian passes
 * to smooth without volume shrinkage. Boundary vertices are pinned.
 */
function taubinSmooth(mesh: RawMesh, iterations = 4, lambda = 0.5, mu = -0.53): RawMesh {
  const t0 = performance.now();
  const vertCount = mesh.vertices.length / VERTEX_FLOATS;
  const triCount = mesh.indices.length / 3;

  // Build adjacency and detect boundary
  const adj: number[][] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) adj[i] = [];
  const edgeTri = new Map<string, number>(); // edge -> adjacent tri count

  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3], i1 = mesh.indices[t * 3 + 1], i2 = mesh.indices[t * 3 + 2];
    const pairs: [number, number][] = [[i0, i1], [i1, i2], [i2, i0]];
    for (const [a, b] of pairs) {
      const key = edgeKey(a, b);
      edgeTri.set(key, (edgeTri.get(key) ?? 0) + 1);
    }
  }
  // Build adjacency (deduplicated)
  const adjSets: Set<number>[] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) adjSets[i] = new Set();
  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3], i1 = mesh.indices[t * 3 + 1], i2 = mesh.indices[t * 3 + 2];
    adjSets[i0].add(i1); adjSets[i0].add(i2);
    adjSets[i1].add(i0); adjSets[i1].add(i2);
    adjSets[i2].add(i0); adjSets[i2].add(i1);
  }
  for (let i = 0; i < vertCount; i++) adj[i] = Array.from(adjSets[i]);

  // Mark boundary vertices
  const pinned = new Uint8Array(vertCount);
  for (const [key, count] of edgeTri) {
    if (count === 1) {
      const [a, b] = key.split(",").map(Number);
      pinned[a] = 1;
      pinned[b] = 1;
    }
  }

  // Working position arrays (double-buffered)
  const pos = new Float64Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    const o = i * VERTEX_FLOATS;
    pos[i * 3]     = mesh.vertices[o];
    pos[i * 3 + 1] = mesh.vertices[o + 1];
    pos[i * 3 + 2] = mesh.vertices[o + 2];
  }

  function laplacianPass(factor: number) {
    // Compute displacements first, apply after (Jacobi iteration)
    const disp = new Float64Array(vertCount * 3);
    for (let v = 0; v < vertCount; v++) {
      if (pinned[v]) continue;
      const nbs = adj[v];
      if (nbs.length === 0) continue;
      const vo = v * 3;
      let lx = 0, ly = 0, lz = 0;
      for (const nb of nbs) {
        const no = nb * 3;
        lx += pos[no]     - pos[vo];
        ly += pos[no + 1] - pos[vo + 1];
        lz += pos[no + 2] - pos[vo + 2];
      }
      const inv = 1 / nbs.length;
      disp[vo]     = factor * lx * inv;
      disp[vo + 1] = factor * ly * inv;
      disp[vo + 2] = factor * lz * inv;
    }
    for (let v = 0; v < vertCount; v++) {
      if (pinned[v]) continue;
      const vo = v * 3;
      pos[vo]     += disp[vo];
      pos[vo + 1] += disp[vo + 1];
      pos[vo + 2] += disp[vo + 2];
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    laplacianPass(lambda);
    laplacianPass(mu);
  }

  // Write back positions
  const outVerts = new Float32Array(mesh.vertices);
  for (let i = 0; i < vertCount; i++) {
    const o = i * VERTEX_FLOATS;
    outVerts[o]     = pos[i * 3];
    outVerts[o + 1] = pos[i * 3 + 1];
    outVerts[o + 2] = pos[i * 3 + 2];
  }

  const elapsed = performance.now() - t0;
  console.log(`Taubin smooth: ${iterations} iterations (λ=${lambda}, μ=${mu}) in ${elapsed.toFixed(0)}ms`);

  return { vertices: outVerts, indices: mesh.indices };
}

// ---------------------------------------------------------------------------
// Material repainting
// ---------------------------------------------------------------------------

/**
 * Reassign per-vertex materials based on final vertex positions and
 * averaged face normals. Replaces per-cell exposure classification
 * after subdivision/smoothing has moved vertices.
 */
function repaintMaterials(mesh: RawMesh, waterHeight: number): RawMesh {
  const t0 = performance.now();
  const vertCount = mesh.vertices.length / VERTEX_FLOATS;
  const triCount = mesh.indices.length / 3;

  // Compute face normals
  const faceNx = new Float64Array(triCount);
  const faceNy = new Float64Array(triCount);
  const faceNz = new Float64Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3], i1 = mesh.indices[t * 3 + 1], i2 = mesh.indices[t * 3 + 2];
    const o0 = i0 * VERTEX_FLOATS, o1 = i1 * VERTEX_FLOATS, o2 = i2 * VERTEX_FLOATS;
    const ax = mesh.vertices[o1] - mesh.vertices[o0];
    const ay = mesh.vertices[o1 + 1] - mesh.vertices[o0 + 1];
    const az = mesh.vertices[o1 + 2] - mesh.vertices[o0 + 2];
    const bx = mesh.vertices[o2] - mesh.vertices[o0];
    const by = mesh.vertices[o2 + 1] - mesh.vertices[o0 + 1];
    const bz = mesh.vertices[o2 + 2] - mesh.vertices[o0 + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    faceNx[t] = nx; faceNy[t] = ny; faceNz[t] = nz;
  }

  // Accumulate face normals per vertex
  const vnx = new Float64Array(vertCount);
  const vny = new Float64Array(vertCount);
  const vnz = new Float64Array(vertCount);

  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.indices[t * 3 + c];
      vnx[v] += faceNx[t];
      vny[v] += faceNy[t];
      vnz[v] += faceNz[t];
    }
  }

  // Classify and assign materials
  const outVerts = new Float32Array(mesh.vertices);

  for (let v = 0; v < vertCount; v++) {
    const o = v * VERTEX_FLOATS;
    const vy = outVerts[o + 1];

    // Normalize accumulated normal
    const nx = vnx[v], ny = vny[v], nz = vnz[v];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const upDot = len > 0 ? ny / len : 0;

    let mat: Material;
    if (vy < waterHeight) {
      mat = Material.Stone;
    } else if (upDot > 0.7) {
      mat = Material.Grass;
    } else if (upDot < -0.7) {
      mat = Material.Stone;
    } else {
      mat = Material.Dirt;
    }

    outVerts[o + 6] = mat;
  }

  const elapsed = performance.now() - t0;
  console.log(`Repaint materials: ${vertCount} verts in ${elapsed.toFixed(0)}ms`);

  return { vertices: outVerts, indices: mesh.indices };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export interface SimplifyOptions {
  subdivide?: boolean;
  smooth?: boolean;
  smoothIterations?: number;
  waterHeight?: number;
}

/**
 * Simplify mesh by collapsing short edges while preserving watertight topology.
 * Optionally applies Loop subdivision, Taubin smoothing, and material repainting.
 */
export function simplifyMesh(mesh: RawMesh, threshold = 0.2, options?: SimplifyOptions): RawMesh {
  // First: build proper shared-vertex mesh
  mesh = deduplicateVertices(mesh);

  const srcVerts = mesh.vertices;
  const srcIdx = mesh.indices;
  const vertCount = srcVerts.length / VERTEX_FLOATS;
  const triCount = srcIdx.length / 3;
  const thresh2 = threshold * threshold;

  // --- Mutable copies ---
  // Position + attributes per vertex
  const pos = new Float64Array(vertCount * 3);
  const norm = new Float64Array(vertCount * 3);
  const mat = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const o = i * VERTEX_FLOATS;
    pos[i * 3] = srcVerts[o];
    pos[i * 3 + 1] = srcVerts[o + 1];
    pos[i * 3 + 2] = srcVerts[o + 2];
    norm[i * 3] = srcVerts[o + 3];
    norm[i * 3 + 1] = srcVerts[o + 4];
    norm[i * 3 + 2] = srcVerts[o + 5];
    mat[i] = srcVerts[o + 6];
  }

  // Triangle indices (mutable)
  const tris = new Int32Array(triCount * 3);
  for (let i = 0; i < tris.length; i++) tris[i] = srcIdx[i];

  // alive[t] = whether triangle t still exists
  const alive = new Uint8Array(triCount).fill(1);

  // Union-find for merged vertices: remap[v] -> surviving vertex
  const remap = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) remap[i] = i;

  function find(x: number): number {
    while (remap[x] !== x) {
      remap[x] = remap[remap[x]];
      x = remap[x];
    }
    return x;
  }

  // Build per-vertex triangle adjacency
  const vertTris: Set<number>[] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) vertTris[i] = new Set();
  for (let t = 0; t < triCount; t++) {
    vertTris[tris[t * 3]].add(t);
    vertTris[tris[t * 3 + 1]].add(t);
    vertTris[tris[t * 3 + 2]].add(t);
  }

  // Collect all edges as candidate collapses
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as [number, number][]) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([lo, hi]);
      }
    }
  }

  // Sort edges by length (shortest first) for greedy collapse
  edges.sort((a, b) => {
    const ao = a[0] * 3, bo = a[1] * 3;
    const dx1 = pos[ao] - pos[bo], dy1 = pos[ao + 1] - pos[bo + 1], dz1 = pos[ao + 2] - pos[bo + 2];
    const co = b[0] * 3, d0 = b[1] * 3;
    const dx2 = pos[co] - pos[d0], dy2 = pos[co + 1] - pos[d0 + 1], dz2 = pos[co + 2] - pos[d0 + 2];
    return (dx1 * dx1 + dy1 * dy1 + dz1 * dz1) - (dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
  });

  let collapseCount = 0;

  for (const [rawA, rawB] of edges) {
    const a = find(rawA);
    const b = find(rawB);
    if (a === b) continue;

    // Check edge length (positions may have changed from prior collapses)
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    if (dx * dx + dy * dy + dz * dz > thresh2) continue;

    // Find triangles that would become degenerate (contain both a and b)
    const degenerate: number[] = [];
    for (const t of vertTris[a]) {
      if (!alive[t]) continue;
      const t0 = find(tris[t * 3]), t1 = find(tris[t * 3 + 1]), t2 = find(tris[t * 3 + 2]);
      if ((t0 === a || t1 === a || t2 === a) && (t0 === b || t1 === b || t2 === b)) {
        degenerate.push(t);
      }
    }
    for (const t of vertTris[b]) {
      if (!alive[t]) continue;
      const t0 = find(tris[t * 3]), t1 = find(tris[t * 3 + 1]), t2 = find(tris[t * 3 + 2]);
      if ((t0 === a || t1 === a || t2 === a) && (t0 === b || t1 === b || t2 === b)) {
        if (!degenerate.includes(t)) degenerate.push(t);
      }
    }

    // Topology check: ensure we won't create non-manifold edges.
    // The "link condition": the set of vertices adjacent to both a and b
    // (excluding a and b themselves) should equal the vertices of the
    // degenerate triangles (excluding a and b). If not, collapse would
    // create a non-manifold edge.
    const adjA = new Set<number>();
    const adjB = new Set<number>();
    for (const t of vertTris[a]) {
      if (!alive[t]) continue;
      for (let j = 0; j < 3; j++) {
        const v = find(tris[t * 3 + j]);
        if (v !== a && v !== b) adjA.add(v);
      }
    }
    for (const t of vertTris[b]) {
      if (!alive[t]) continue;
      for (let j = 0; j < 3; j++) {
        const v = find(tris[t * 3 + j]);
        if (v !== a && v !== b) adjB.add(v);
      }
    }
    // Shared neighbors
    let sharedCount = 0;
    for (const v of adjA) if (adjB.has(v)) sharedCount++;
    // Should equal number of degenerate triangles (typically 2 for manifold edge)
    if (sharedCount !== degenerate.length) continue;

    // --- Perform collapse: merge b into a ---
    // Move a to midpoint
    pos[a * 3] = (ax + bx) / 2;
    pos[a * 3 + 1] = (ay + by) / 2;
    pos[a * 3 + 2] = (az + bz) / 2;
    // Average normals
    const nx = norm[a * 3] + norm[b * 3];
    const ny = norm[a * 3 + 1] + norm[b * 3 + 1];
    const nz = norm[a * 3 + 2] + norm[b * 3 + 2];
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nlen > 0) {
      norm[a * 3] = nx / nlen;
      norm[a * 3 + 1] = ny / nlen;
      norm[a * 3 + 2] = nz / nlen;
    }

    // Kill degenerate triangles
    for (const t of degenerate) alive[t] = 0;

    // Repoint b -> a in union-find
    remap[b] = a;

    // Transfer b's triangle references to a
    for (const t of vertTris[b]) {
      if (alive[t]) vertTris[a].add(t);
    }

    collapseCount++;
  }

  // --- Compact output ---
  // Resolve all remaps
  for (let i = 0; i < tris.length; i++) {
    tris[i] = find(tris[i]);
  }

  // Collect surviving vertices
  const usedSet = new Set<number>();
  const outIndices: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (!alive[t]) continue;
    const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) continue; // extra safety
    usedSet.add(i0);
    usedSet.add(i1);
    usedSet.add(i2);
    outIndices.push(i0, i1, i2);
  }

  // Reindex to compact array
  const oldToNew = new Map<number, number>();
  const outVerts: number[] = [];
  let ni = 0;
  for (const v of usedSet) {
    oldToNew.set(v, ni++);
    outVerts.push(
      pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2],
      norm[v * 3], norm[v * 3 + 1], norm[v * 3 + 2],
      mat[v],
    );
  }

  for (let i = 0; i < outIndices.length; i++) {
    outIndices[i] = oldToNew.get(outIndices[i])!;
  }

  const origTris = triCount;
  const finalTris = outIndices.length / 3;
  console.log(`Simplify: ${collapseCount} collapses, ${vertCount} -> ${ni} verts, ${origTris} -> ${finalTris} tris (threshold ${threshold})`);

  let result: RawMesh = {
    vertices: new Float32Array(outVerts),
    indices: new Uint32Array(outIndices),
  };

  // Optional subdivision + smoothing + repaint
  if (options?.subdivide) {
    result = loopSubdivide(result);
  }
  if (options?.smooth) {
    result = taubinSmooth(result, options.smoothIterations ?? 4);
  }
  if ((options?.subdivide || options?.smooth) && options?.waterHeight !== undefined) {
    result = repaintMaterials(result, options.waterHeight);
  }

  return recalcNormals(result);
}

/**
 * Recalculate normals with auto-smooth: faces sharing a vertex whose face
 * normals differ by more than `angleThreshold` (radians) get split vertices
 * with separate normals. Faces within the threshold share averaged normals.
 */
function recalcNormals(mesh: RawMesh, angleThreshold = 40 * Math.PI / 180): RawMesh {
  const vertCount = mesh.vertices.length / VERTEX_FLOATS;
  const triCount = mesh.indices.length / 3;
  const cosThresh = Math.cos(angleThreshold);

  // --- 1. Compute face normals ---
  const faceNx = new Float64Array(triCount);
  const faceNy = new Float64Array(triCount);
  const faceNz = new Float64Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3], i1 = mesh.indices[t * 3 + 1], i2 = mesh.indices[t * 3 + 2];
    const o0 = i0 * VERTEX_FLOATS, o1 = i1 * VERTEX_FLOATS, o2 = i2 * VERTEX_FLOATS;
    const ax = mesh.vertices[o1] - mesh.vertices[o0];
    const ay = mesh.vertices[o1 + 1] - mesh.vertices[o0 + 1];
    const az = mesh.vertices[o1 + 2] - mesh.vertices[o0 + 2];
    const bx = mesh.vertices[o2] - mesh.vertices[o0];
    const by = mesh.vertices[o2 + 1] - mesh.vertices[o0 + 1];
    const bz = mesh.vertices[o2 + 2] - mesh.vertices[o0 + 2];
    // cross product
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    faceNx[t] = nx; faceNy[t] = ny; faceNz[t] = nz;
  }

  // --- 2. Build per-vertex face list ---
  const vertFaces: number[][] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) vertFaces[i] = [];
  for (let t = 0; t < triCount; t++) {
    vertFaces[mesh.indices[t * 3]].push(t);
    vertFaces[mesh.indices[t * 3 + 1]].push(t);
    vertFaces[mesh.indices[t * 3 + 2]].push(t);
  }

  // --- 3. For each vertex, group its faces into smooth groups ---
  // Two faces are in the same smooth group if their normals' dot >= cosThresh
  // and they're connected through faces that all satisfy the angle test.
  // vertSplit[v] = array of { faces: number[], normal: [nx,ny,nz] }
  type SmoothGroup = { faces: number[]; nx: number; ny: number; nz: number };
  const vertGroups: SmoothGroup[][] = new Array(vertCount);

  for (let v = 0; v < vertCount; v++) {
    const faces = vertFaces[v];
    if (faces.length === 0) { vertGroups[v] = []; continue; }

    const assigned = new Uint8Array(faces.length);
    const groups: SmoothGroup[] = [];

    for (let fi = 0; fi < faces.length; fi++) {
      if (assigned[fi]) continue;
      // BFS: group faces connected by smooth edges
      const group: number[] = [fi];
      assigned[fi] = 1;
      let head = 0;
      while (head < group.length) {
        const ci = group[head++];
        const ct = faces[ci];
        for (let oi = 0; oi < faces.length; oi++) {
          if (assigned[oi]) continue;
          const ot = faces[oi];
          const dot = faceNx[ct] * faceNx[ot] + faceNy[ct] * faceNy[ot] + faceNz[ct] * faceNz[ot];
          if (dot >= cosThresh) {
            assigned[oi] = 1;
            group.push(oi);
          }
        }
      }

      // Average normal for this group
      let snx = 0, sny = 0, snz = 0;
      const groupFaces: number[] = [];
      for (const gi of group) {
        const t = faces[gi];
        groupFaces.push(t);
        snx += faceNx[t]; sny += faceNy[t]; snz += faceNz[t];
      }
      const len = Math.sqrt(snx * snx + sny * sny + snz * snz);
      if (len > 0) { snx /= len; sny /= len; snz /= len; }
      groups.push({ faces: groupFaces, nx: snx, ny: sny, nz: snz });
    }

    vertGroups[v] = groups;
  }

  // --- 4. Emit split vertices ---
  // For each triangle corner, find which smooth group it belongs to,
  // and emit a vertex with that group's normal.
  const outVerts: number[] = [];
  const outIndices = new Uint32Array(triCount * 3);
  let outVertCount = 0;

  // Cache: for vertex v, group index g -> new vertex index
  const cache: Map<number, Map<number, number>> = new Map();

  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.indices[t * 3 + c];
      const groups = vertGroups[v];

      // Find which group this triangle belongs to
      let gi = 0;
      for (let g = 0; g < groups.length; g++) {
        if (groups[g].faces.includes(t)) { gi = g; break; }
      }

      let vertCache = cache.get(v);
      if (!vertCache) { vertCache = new Map(); cache.set(v, vertCache); }

      let ni = vertCache.get(gi);
      if (ni === undefined) {
        ni = outVertCount++;
        vertCache.set(gi, ni);
        const vo = v * VERTEX_FLOATS;
        const grp = groups[gi];
        outVerts.push(
          mesh.vertices[vo], mesh.vertices[vo + 1], mesh.vertices[vo + 2],
          grp.nx, grp.ny, grp.nz,
          mesh.vertices[vo + 6],
        );
      }

      outIndices[t * 3 + c] = ni;
    }
  }

  console.log(`Normals: ${vertCount} -> ${outVertCount} verts (${outVertCount - vertCount} splits, angle ${(angleThreshold * 180 / Math.PI).toFixed(0)}°)`);

  return {
    vertices: new Float32Array(outVerts),
    indices: outIndices,
  };
}
