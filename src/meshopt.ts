/**
 * Mesh post-processing: edge-collapse simplification.
 * Vertex format: 7 floats per vertex (x, y, z, nx, ny, nz, mat).
 * Maintains watertight topology by only collapsing edges where the
 * local neighborhood stays manifold.
 */

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

/**
 * Simplify mesh by collapsing short edges while preserving watertight topology.
 * First deduplicates exact-position vertices to build shared topology,
 * then collapses edges shorter than `threshold` to their midpoint.
 */
export function simplifyMesh(mesh: RawMesh, threshold = 0.2): RawMesh {
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

  const collapsed: RawMesh = {
    vertices: new Float32Array(outVerts),
    indices: new Uint32Array(outIndices),
  };

  return recalcNormals(collapsed);
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
