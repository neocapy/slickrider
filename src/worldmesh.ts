import { Material, MATERIAL_INFO } from "./materials";
import { World } from "./world";

export interface WorldMesh {
  opaqueVertices: Float32Array;
  opaqueIndices: Uint32Array;
  transparentVertices: Float32Array;
  transparentIndices: Uint32Array;
}

// Vertex: pos(3) + normal(3) + materialIndex(1) = 7 floats = 28 bytes
export const VERTEX_FLOATS = 7;

function shouldEmitFace(block: Material, neighbor: Material): boolean {
  const blockInfo = MATERIAL_INFO[block];
  const neighborInfo = MATERIAL_INFO[neighbor];

  // Don't render faces between two opaque blocks
  if (blockInfo.isOpaque && neighborInfo.isOpaque) return false;

  // Don't render faces between two water blocks
  if (block === Material.Water && neighbor === Material.Water) return false;

  // Water only renders faces against air (including out-of-bounds)
  if (block === Material.Water && neighbor !== Material.Air) return false;

  // Render faces adjacent to air or transparent neighbors
  return true;
}

// Face directions and their 2D grid mapping
// For each face: normal direction, slice axis, grid u-axis, grid v-axis
// u/v define the two axes of the 2D slice grid
interface FaceDef {
  // Normal direction
  nx: number; ny: number; nz: number;
  // Which world axis the slice iterates along (0=X, 1=Y, 2=Z)
  sliceAxis: number;
  // The two grid axes (world axis indices)
  uAxis: number;
  vAxis: number;
  // Slice offset: the face sits at slice or slice+1 along sliceAxis
  sliceOffset: number;
}

const FACE_DEFS: FaceDef[] = [
  // +X: slice along X, grid is (Z, Y), face at x+1
  { nx: 1, ny: 0, nz: 0, sliceAxis: 0, uAxis: 2, vAxis: 1, sliceOffset: 1 },
  // -X: slice along X, grid is (Z, Y), face at x
  { nx: -1, ny: 0, nz: 0, sliceAxis: 0, uAxis: 2, vAxis: 1, sliceOffset: 0 },
  // +Y: slice along Y, grid is (X, Z), face at y+1
  { nx: 0, ny: 1, nz: 0, sliceAxis: 1, uAxis: 0, vAxis: 2, sliceOffset: 1 },
  // -Y: slice along Y, grid is (X, Z), face at y
  { nx: 0, ny: -1, nz: 0, sliceAxis: 1, uAxis: 0, vAxis: 2, sliceOffset: 0 },
  // +Z: slice along Z, grid is (X, Y), face at z+1
  { nx: 0, ny: 0, nz: 1, sliceAxis: 2, uAxis: 0, vAxis: 1, sliceOffset: 1 },
  // -Z: slice along Z, grid is (X, Y), face at z
  { nx: 0, ny: 0, nz: -1, sliceAxis: 2, uAxis: 0, vAxis: 1, sliceOffset: 0 },
];

// World axis sizes and offsets (to convert grid coords to world coords)
const AXIS_SIZE = [World.SIZE_X, World.SIZE_Y, World.SIZE_Z];
const AXIS_MIN = [-World.HALF_X, 0, -World.HALF_Z];

function getWorldCoord(axis: number, gridIdx: number): number {
  return gridIdx + AXIS_MIN[axis];
}

function worldGet(world: World, coords: [number, number, number]): Material {
  return world.get(coords[0], coords[1], coords[2]);
}

export function buildWorldMesh(world: World): WorldMesh {
  const oVerts: number[] = [];
  const oIdxs: number[] = [];
  const tVerts: number[] = [];
  const tIdxs: number[] = [];

  let oVertCount = 0;
  let tVertCount = 0;

  for (const face of FACE_DEFS) {
    const { nx, ny, nz, sliceAxis, uAxis, vAxis, sliceOffset } = face;
    const sliceCount = AXIS_SIZE[sliceAxis];
    const uSize = AXIS_SIZE[uAxis];
    const vSize = AXIS_SIZE[vAxis];

    // Reusable grid for each slice (material or 0 for no-face)
    const grid = new Uint8Array(uSize * vSize);

    for (let slice = 0; slice < sliceCount; slice++) {
      // Build the 2D grid for this slice
      let hasAny = false;
      for (let v = 0; v < vSize; v++) {
        for (let u = 0; u < uSize; u++) {
          // Map (slice, u, v) to world coordinates
          const coords: [number, number, number] = [0, 0, 0];
          coords[sliceAxis] = getWorldCoord(sliceAxis, slice);
          coords[uAxis] = getWorldCoord(uAxis, u);
          coords[vAxis] = getWorldCoord(vAxis, v);

          const mat = worldGet(world, coords);
          if (mat === Material.Air) {
            grid[v * uSize + u] = 0;
            continue;
          }

          // Check neighbor in normal direction
          const nCoords: [number, number, number] = [
            coords[0] + nx,
            coords[1] + ny,
            coords[2] + nz,
          ];
          const neighbor = worldGet(world, nCoords);

          if (shouldEmitFace(mat, neighbor)) {
            grid[v * uSize + u] = mat;
            hasAny = true;
          } else {
            grid[v * uSize + u] = 0;
          }
        }
      }

      if (!hasAny) continue;

      // Greedy merge
      for (let v = 0; v < vSize; v++) {
        for (let u = 0; u < uSize; u++) {
          const mat = grid[v * uSize + u];
          if (mat === 0) continue;

          // Extend width (u direction)
          let w = 1;
          while (u + w < uSize && grid[v * uSize + u + w] === mat) w++;

          // Extend height (v direction)
          let h = 1;
          outer: while (v + h < vSize) {
            for (let du = 0; du < w; du++) {
              if (grid[(v + h) * uSize + u + du] !== mat) break outer;
            }
            h++;
          }

          // Clear merged cells
          for (let dv = 0; dv < h; dv++) {
            for (let du = 0; du < w; du++) {
              grid[(v + dv) * uSize + u + du] = 0;
            }
          }

          // Emit quad
          const isOpaque = MATERIAL_INFO[mat].isOpaque;
          const verts = isOpaque ? oVerts : tVerts;
          const idxs = isOpaque ? oIdxs : tIdxs;
          const baseVertex = isOpaque ? oVertCount : tVertCount;

          // Compute the 4 corner positions in world space
          // The face plane sits at slice + sliceOffset along sliceAxis
          const sliceWorld = getWorldCoord(sliceAxis, slice) + sliceOffset;
          const u0 = getWorldCoord(uAxis, u);
          const v0 = getWorldCoord(vAxis, v);
          const u1 = u0 + w;
          const v1 = v0 + h;

          // Map (u, v) grid coords + slice position to world-space position
          const p = (uVal: number, vVal: number): [number, number, number] => {
            const c: [number, number, number] = [0, 0, 0];
            c[sliceAxis] = sliceWorld;
            c[uAxis] = uVal;
            c[vAxis] = vVal;
            return c;
          };

          // Winding order depends on face direction to ensure CCW from outside
          // For positive normal faces: (u0,v0), (u0,v1), (u1,v1), (u1,v0)
          // For negative normal faces: (u0,v0), (u1,v0), (u1,v1), (u0,v1)
          // But this depends on the specific axis mapping. Let's use a
          // cross-product check to get consistent winding.
          let quadVerts: [number, number, number][];

          // Default order
          const p00 = p(u0, v0);
          const p10 = p(u1, v0);
          const p11 = p(u1, v1);
          const p01 = p(u0, v1);

          // Check winding: compute face normal from cross product of edges
          // edge1 = p10 - p00, edge2 = p01 - p00
          const e1x = p10[0] - p00[0], e1y = p10[1] - p00[1], e1z = p10[2] - p00[2];
          const e2x = p01[0] - p00[0], e2y = p01[1] - p00[1], e2z = p01[2] - p00[2];
          const cx = e1y * e2z - e1z * e2y;
          const cy = e1z * e2x - e1x * e2z;
          const cz = e1x * e2y - e1y * e2x;

          // If cross product dot normal > 0, order is CCW from outside; else flip
          const dot = cx * nx + cy * ny + cz * nz;
          if (dot > 0) {
            quadVerts = [p00, p10, p11, p01];
          } else {
            quadVerts = [p00, p01, p11, p10];
          }

          for (const qv of quadVerts) {
            verts.push(qv[0], qv[1], qv[2], nx, ny, nz, mat);
          }

          // Two triangles: 0-1-2, 0-2-3
          idxs.push(
            baseVertex, baseVertex + 1, baseVertex + 2,
            baseVertex, baseVertex + 2, baseVertex + 3,
          );

          if (isOpaque) oVertCount += 4;
          else tVertCount += 4;
        }
      }
    }
  }

  return {
    opaqueVertices: new Float32Array(oVerts),
    opaqueIndices: new Uint32Array(oIdxs),
    transparentVertices: new Float32Array(tVerts),
    transparentIndices: new Uint32Array(tIdxs),
  };
}
