/**
 * Convex cell represented in dual form, following Ray et al. 2018.
 *
 * P[] = array of plane equations (a, b, c, d) where ax + by + cz + d > 0 is "inside"
 * T[] = dual triangles — each is 3 plane indices whose intersection gives a vertex
 *
 * Each face of the cell corresponds to a plane. Each vertex is the intersection
 * of exactly 3 planes. No explicit vertex positions are stored.
 *
 * neighborOf[planeIdx] = site index of the neighbor that produced this clipping plane,
 * or -1 for bounding box planes.
 */

import type { Vec3 } from "./math";

// Plane equation: ax + by + cz + d > 0 is inside
type Plane = [number, number, number, number]; // a, b, c, d

// Dual triangle: 3 plane indices
type Tri = [number, number, number];

const BOUNDARY_NEIGHBOR = -1;

export class ConvexCell {
  planes: Plane[];
  tris: Tri[];
  numTris: number;
  neighborOf: Int32Array; // per-plane: which site produced it (-1 = boundary)

  private constructor(planes: Plane[], tris: Tri[], neighborOf: Int32Array) {
    this.planes = planes;
    this.tris = tris;
    this.numTris = tris.length;
    this.neighborOf = neighborOf;
  }

  /**
   * Initialize a cell as the bounding box of the world.
   * 6 planes, 12 triangles (2 per face, forming the dual mesh of a cube).
   */
  static fromBoundingBox(xMin: number, xMax: number, yMin: number, yMax: number, zMin: number, zMax: number): ConvexCell {
    // Planes: normal pointing inward, ax+by+cz+d > 0 is inside
    const planes: Plane[] = [
      [ 1,  0,  0, -xMin], // 0: +X face (x > xMin)
      [-1,  0,  0,  xMax], // 1: -X face (x < xMax)
      [ 0,  1,  0, -yMin], // 2: +Y face (y > yMin)
      [ 0, -1,  0,  yMax], // 3: -Y face (y < yMax)
      [ 0,  0,  1, -zMin], // 4: +Z face (z > zMin)
      [ 0,  0, -1,  zMax], // 5: -Z face (z < zMax)
    ];

    // 12 dual triangles forming the cube mesh.
    // Each triangle (u,v,w) represents a vertex at the intersection of planes u,v,w.
    // Critical: directed edges must be consistent — each edge (a,b) in one triangle
    // must appear as (b,a) in exactly one other triangle (manifold property).
    //
    // The paper's Fig. 8 gives the initialization directly.
    // Our planes: 0=+x(xMin), 1=-x(xMax), 2=+y(yMin), 3=-y(yMax), 4=+z(zMin), 5=-z(zMax)
    // Paper's planes: 0=+x, 1=-x, 2=+y, 3=-y, 4=+z, 5=-z — same mapping.
    //
    // Paper's T: (2,5,0), (5,3,0), (1,5,2), (5,1,3), (4,2,0), (4,0,3), (2,4,1), (4,3,1)
    // Plus 4 more for the other diagonal of each face:
    // Full 12 triangles from paper (§3.2):
    const tris: Tri[] = [
      [2, 5, 0], [5, 3, 0],  // face of plane 0 (x=xMin)
      [1, 5, 2], [5, 1, 3],  // face of plane 5 (z=zMax) — partial
      [4, 2, 0], [4, 0, 3],  // face of plane 4 (z=zMin) — partial
      [2, 4, 1], [4, 3, 1],  // face of plane 1 (x=xMax) — partial
      [0, 2, 1], [0, 1, 3],  // face of plane 2/3 diag
      [5, 2, 1], [5, 0, 4],  // remaining
    ];

    const neighborOf = new Int32Array(6).fill(BOUNDARY_NEIGHBOR);

    return new ConvexCell(planes, tris, neighborOf);
  }

  /** Compute the 3D position of a vertex (intersection of 3 planes). */
  vertexPosition(triIdx: number): Vec3 | null {
    const [a, b, c] = this.tris[triIdx];
    return intersect3Planes(this.planes[a], this.planes[b], this.planes[c]);
  }

  /**
   * Clip this cell by a half-space. The plane normal points toward the site
   * (i.e., the "inside" of the new constraint is ax+by+cz+d > 0).
   *
   * neighborIdx is the site index that produced this clipping plane.
   *
   * Returns true if the cell is still valid (non-degenerate).
   */
  clipByPlane(plane: Plane, neighborIdx: number): boolean {
    const newPlaneIdx = this.planes.length;
    this.planes.push(plane);

    // Grow neighborOf array
    const newNeighborOf = new Int32Array(this.planes.length);
    newNeighborOf.set(this.neighborOf);
    newNeighborOf[newPlaneIdx] = neighborIdx;
    this.neighborOf = newNeighborOf;

    // Identify which dual triangles (vertices) are clipped.
    // A vertex is clipped if its position is on the wrong side of the plane (dot < 0).
    const removed: Tri[] = [];
    const removedSet = new Set<number>(); // indices into this.tris
    const kept: Tri[] = [];

    for (let i = 0; i < this.numTris; i++) {
      const tri = this.tris[i];
      const pos = intersect3Planes(this.planes[tri[0]], this.planes[tri[1]], this.planes[tri[2]]);
      if (pos === null) {
        // Degenerate — skip
        kept.push(tri);
        continue;
      }
      const dot = plane[0] * pos[0] + plane[1] * pos[1] + plane[2] * pos[2] + plane[3];
      if (dot < 0) {
        removed.push(tri);
        removedSet.add(i);
      } else {
        kept.push(tri);
      }
    }

    if (removed.length === 0) {
      // Nothing clipped, plane is entirely outside — remove the plane we just added
      this.planes.pop();
      this.neighborOf = this.neighborOf.slice(0, this.planes.length);
      return true;
    }

    // Find the boundary of the removed region.
    // The boundary is a cycle of edges (pairs of plane indices) where exactly
    // one adjacent triangle is removed.
    const boundary = this.computeBoundary(removed);
    if (boundary.length === 0) {
      // Degenerate clip
      this.tris = kept;
      this.numTris = kept.length;
      return this.numTris >= 4;
    }

    // For each boundary edge, create a new triangle connecting to the new plane
    for (const [s, t] of boundary) {
      kept.push([s, t, newPlaneIdx]);
    }

    this.tris = kept;
    this.numTris = kept.length;
    return this.numTris >= 4;
  }

  /**
   * Compute the boundary cycle of a set of removed triangles.
   * An edge (s,t) of a removed triangle is a boundary edge if the triangle
   * on the other side is NOT removed.
   *
   * Returns the boundary as an ordered list of edges forming a cycle.
   * Each edge is [planeIdx, planeIdx].
   */
  private computeBoundary(removed: Tri[]): [number, number][] {
    // Collect all directed edges of removed triangles.
    // A triangle (u,v,w) has edges: (u,v), (v,w), (w,u)
    // An edge is boundary if its reverse is NOT in the removed set.

    // Build set of all directed edges from ALL triangles for adjacency lookup
    // Actually, simpler: collect directed edges of removed triangles,
    // and an edge is boundary if its reverse does NOT appear among removed edges.
    const removedEdges = new Set<string>();
    const boundaryEdges: [number, number][] = [];

    for (const tri of removed) {
      const edges: [number, number][] = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
      for (const [s, t] of edges) {
        removedEdges.add(`${s},${t}`);
      }
    }

    for (const tri of removed) {
      const edges: [number, number][] = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
      for (const [s, t] of edges) {
        // It's a boundary edge if the reverse is not in removed edges
        if (!removedEdges.has(`${t},${s}`)) {
          boundaryEdges.push([s, t]);
        }
      }
    }

    if (boundaryEdges.length === 0) return [];

    // Order the boundary edges into a cycle.
    // Each edge's end should match the next edge's start.
    const edgeMap = new Map<number, [number, number]>();
    for (const edge of boundaryEdges) {
      edgeMap.set(edge[0], edge);
    }

    const cycle: [number, number][] = [];
    let current = boundaryEdges[0];
    for (let i = 0; i < boundaryEdges.length; i++) {
      cycle.push(current);
      const next = edgeMap.get(current[1]);
      if (!next) break;
      current = next;
    }

    return cycle;
  }

  /**
   * Extract mesh faces for this cell. Each plane in the cell corresponds to a face.
   * Returns face data: for each face, the ordered vertex positions and the neighbor index.
   */
  extractFaces(): { vertices: Vec3[]; neighbor: number; planeIdx: number }[] {
    const faces: { vertices: Vec3[]; neighbor: number; planeIdx: number }[] = [];

    // Group triangles by each plane they reference.
    // A triangle (a,b,c) contributes a vertex to the face of each of its 3 planes.
    // For face of plane P: collect all tris containing P, the vertex is the
    // intersection of the other two planes + P.
    const planeToTris = new Map<number, number[]>();
    for (let i = 0; i < this.numTris; i++) {
      const tri = this.tris[i];
      for (const p of tri) {
        if (!planeToTris.has(p)) planeToTris.set(p, []);
        planeToTris.get(p)!.push(i);
      }
    }

    for (const [planeIdx, triIndices] of planeToTris) {
      if (triIndices.length < 3) continue;

      // Compute vertex positions for this face
      const verts: Vec3[] = [];
      for (const ti of triIndices) {
        const pos = this.vertexPosition(ti);
        if (pos) verts.push(pos);
      }
      if (verts.length < 3) continue;

      // Order vertices around the face by angle from centroid
      const cx = verts.reduce((s, v) => s + v[0], 0) / verts.length;
      const cy = verts.reduce((s, v) => s + v[1], 0) / verts.length;
      const cz = verts.reduce((s, v) => s + v[2], 0) / verts.length;

      const plane = this.planes[planeIdx];
      const normal: Vec3 = [plane[0], plane[1], plane[2]];

      // Build a tangent frame on the face
      const [u, v] = tangentFrame(normal);

      // Project vertices onto tangent frame and sort by angle
      const withAngle = verts.map(vert => {
        const dx = vert[0] - cx;
        const dy = vert[1] - cy;
        const dz = vert[2] - cz;
        const pu = dx * u[0] + dy * u[1] + dz * u[2];
        const pv = dx * v[0] + dy * v[1] + dz * v[2];
        return { vert, angle: Math.atan2(pv, pu) };
      });
      withAngle.sort((a, b) => a.angle - b.angle);

      faces.push({
        vertices: withAngle.map(w => w.vert),
        neighbor: this.neighborOf[planeIdx],
        planeIdx,
      });
    }

    return faces;
  }
}

/** Intersect 3 planes, returning the point or null if degenerate. */
function intersect3Planes(p0: Plane, p1: Plane, p2: Plane): Vec3 | null {
  // Each plane: ax + by + cz = -d
  // Solve the 3x3 system via Cramer's rule
  const a1 = p0[0], b1 = p0[1], c1 = p0[2], d1 = -p0[3];
  const a2 = p1[0], b2 = p1[1], c2 = p1[2], d2 = -p1[3];
  const a3 = p2[0], b3 = p2[1], c3 = p2[2], d3 = -p2[3];

  const det = a1 * (b2 * c3 - b3 * c2)
            - b1 * (a2 * c3 - a3 * c2)
            + c1 * (a2 * b3 - a3 * b2);

  if (Math.abs(det) < 1e-10) return null;

  const invDet = 1 / det;
  const x = (d1 * (b2 * c3 - b3 * c2) - b1 * (d2 * c3 - d3 * c2) + c1 * (d2 * b3 - d3 * b2)) * invDet;
  const y = (a1 * (d2 * c3 - d3 * c2) - d1 * (a2 * c3 - a3 * c2) + c1 * (a2 * d3 - a3 * d2)) * invDet;
  const z = (a1 * (b2 * d3 - b3 * d2) - b1 * (a2 * d3 - a3 * d2) + d1 * (a2 * b3 - a3 * b2)) * invDet;

  return [x, y, z];
}

/** Build an orthonormal tangent frame from a normal vector. */
function tangentFrame(n: Vec3): [Vec3, Vec3] {
  // Pick a vector not parallel to n
  const absX = Math.abs(n[0]);
  const absY = Math.abs(n[1]);
  const absZ = Math.abs(n[2]);
  let up: Vec3;
  if (absX <= absY && absX <= absZ) up = [1, 0, 0];
  else if (absY <= absZ) up = [0, 1, 0];
  else up = [0, 0, 1];

  // u = normalize(up × n)
  let ux = up[1] * n[2] - up[2] * n[1];
  let uy = up[2] * n[0] - up[0] * n[2];
  let uz = up[0] * n[1] - up[1] * n[0];
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= uLen; uy /= uLen; uz /= uLen;

  // v = n × u
  const vx = n[1] * uz - n[2] * uy;
  const vy = n[2] * ux - n[0] * uz;
  const vz = n[0] * uy - n[1] * ux;

  return [[ux, uy, uz], [vx, vy, vz]];
}

/**
 * Build Voronoi cells for all sites using k-NN clipping.
 * Returns array of ConvexCell (one per site).
 */
export function buildVoronoiCells(
  sites: Float64Array,
  knn: Uint32Array,
  k: number,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  zMin: number, zMax: number,
): ConvexCell[] {
  const t0 = performance.now();
  const n = sites.length / 3;
  const cells: ConvexCell[] = [];

  for (let i = 0; i < n; i++) {
    const sx = sites[i * 3];
    const sy = sites[i * 3 + 1];
    const sz = sites[i * 3 + 2];

    const cell = ConvexCell.fromBoundingBox(xMin, xMax, yMin, yMax, zMin, zMax);

    // Clip by each neighbor's bisector plane
    for (let ni = 0; ni < k; ni++) {
      const j = knn[i * k + ni];
      if (j === i) continue;

      const jx = sites[j * 3];
      const jy = sites[j * 3 + 1];
      const jz = sites[j * 3 + 2];

      // Bisector plane: midpoint between i and j, normal pointing toward i
      const mx = (sx + jx) * 0.5;
      const my = (sy + jy) * 0.5;
      const mz = (sz + jz) * 0.5;

      // Normal = (site_i - site_j), normalized
      let nx = sx - jx;
      let ny = sy - jy;
      let nz = sz - jz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      nx /= len; ny /= len; nz /= len;

      // Plane: nx*x + ny*y + nz*z + d > 0, where d = -(nx*mx + ny*my + nz*mz)
      const d = -(nx * mx + ny * my + nz * mz);

      // Security radius check: if this neighbor is more than 2× the
      // bounding ball radius away, it can't affect the cell
      // (We skip this optimization for now — k is small)

      const valid = cell.clipByPlane([nx, ny, nz, d], j);
      if (!valid) break;
    }

    cells.push(cell);
  }

  const elapsed = performance.now() - t0;
  console.log(`Voronoi cells: built ${n} cells in ${elapsed.toFixed(1)}ms`);
  return cells;
}

/**
 * Extract mesh geometry from Voronoi cells, culling internal faces.
 * solid[i] = true means cell i is solid.
 * Only emits faces where solid differs on the two sides.
 * Returns flat arrays of vertices (x,y,z,nx,ny,nz,mat) and indices.
 */
export function extractVoronoiMesh(
  cells: ConvexCell[],
  solid: boolean[],
  material: number | Uint8Array,
): { vertices: Float32Array; indices: Uint32Array } {
  const verts: number[] = [];
  const idxs: number[] = [];
  let vertCount = 0;

  for (let ci = 0; ci < cells.length; ci++) {
    if (!solid[ci]) {
      // Still need to check: an empty cell might border a solid cell,
      // but those faces will be emitted from the solid cell's side.
      continue;
    }

    const faces = cells[ci].extractFaces();
    for (const face of faces) {
      const neighborSite = face.neighbor;

      // Determine if we should emit this face
      let neighborSolid: boolean;
      if (neighborSite === BOUNDARY_NEIGHBOR) {
        // Boundary face — treat outside as empty
        neighborSolid = false;
      } else {
        neighborSolid = solid[neighborSite];
      }

      // Only emit if the other side is different (solid vs empty)
      if (neighborSolid) continue; // both solid — skip

      const faceVerts = face.vertices;
      if (faceVerts.length < 3) continue;

      // Face normal: plane normal points inward (toward solid), so negate for outward
      const plane = cells[ci].planes[face.planeIdx];
      const nx = -plane[0], ny = -plane[1], nz = -plane[2];

      // Fan triangulate the face (reversed winding for outward-facing)
      const baseVert = vertCount;
      for (const v of faceVerts) {
        const mat = typeof material === "number" ? material : material[ci];
        verts.push(v[0], v[1], v[2], nx, ny, nz, mat);
        vertCount++;
      }
      for (let fi = 1; fi < faceVerts.length - 1; fi++) {
        idxs.push(baseVert, baseVert + fi + 1, baseVert + fi);
      }
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idxs),
  };
}

