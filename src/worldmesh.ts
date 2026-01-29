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

// 6 face directions: [dx, dy, dz, normalAxis]
const FACES: [number, number, number][] = [
  [1, 0, 0],   // +X
  [-1, 0, 0],  // -X
  [0, 1, 0],   // +Y
  [0, -1, 0],  // -Y
  [0, 0, 1],   // +Z
  [0, 0, -1],  // -Z
];

// For each face direction, the 4 quad vertices as offsets from block origin
// Vertices are ordered for CCW winding when viewed from outside
const FACE_VERTS: [number, number, number][][] = [
  // +X face (x=1 plane)
  [[1,1,0], [1,1,1], [1,0,1], [1,0,0]],
  // -X face (x=0 plane)
  [[0,1,1], [0,1,0], [0,0,0], [0,0,1]],
  // +Y face (y=1 plane)
  [[0,1,1], [1,1,1], [1,1,0], [0,1,0]],
  // -Y face (y=0 plane)
  [[0,0,0], [1,0,0], [1,0,1], [0,0,1]],
  // +Z face (z=1 plane)
  [[1,0,1], [1,1,1], [0,1,1], [0,0,1]],
  // -Z face (z=0 plane)
  [[0,0,0], [0,1,0], [1,1,0], [1,0,0]],
];

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

export function buildWorldMesh(world: World): WorldMesh {
  // Pre-allocate generous buffers, then trim
  const oVerts: number[] = [];
  const oIdxs: number[] = [];
  const tVerts: number[] = [];
  const tIdxs: number[] = [];

  let oVertCount = 0;
  let tVertCount = 0;

  for (let y = 0; y < World.SIZE_Y; y++) {
    for (let z = -World.HALF_Z; z < World.HALF_Z; z++) {
      for (let x = -World.HALF_X; x < World.HALF_X; x++) {
        const mat = world.get(x, y, z);
        if (mat === Material.Air) continue;

        const info = MATERIAL_INFO[mat];
        const isOpaque = info.isOpaque;

        for (let f = 0; f < 6; f++) {
          const [dx, dy, dz] = FACES[f];
          const neighbor = world.get(x + dx, y + dy, z + dz);

          if (!shouldEmitFace(mat, neighbor)) continue;

          const verts = isOpaque ? oVerts : tVerts;
          const idxs = isOpaque ? oIdxs : tIdxs;
          const baseVertex = isOpaque ? oVertCount : tVertCount;

          const fv = FACE_VERTS[f];
          for (let v = 0; v < 4; v++) {
            const [vx, vy, vz] = fv[v];
            verts.push(
              x + vx, y + vy, z + vz, // position
              dx, dy, dz,              // normal
              mat,                     // material index
            );
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
