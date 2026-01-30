import { Material } from "./materials";

export interface WorldBounds {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface SceneMesh {
  opaqueVertices: Float32Array;
  opaqueIndices: Uint32Array;
  transparentVertices: Float32Array;
  transparentIndices: Uint32Array;
}

export const VERTEX_FLOATS = 7;

function pushQuad(
  verts: number[], idxs: number[], base: { v: number },
  p0x: number, p0y: number, p0z: number,
  p1x: number, p1y: number, p1z: number,
  p2x: number, p2y: number, p2z: number,
  p3x: number, p3y: number, p3z: number,
  nx: number, ny: number, nz: number,
  mat: number,
): void {
  verts.push(p0x, p0y, p0z, nx, ny, nz, mat);
  verts.push(p1x, p1y, p1z, nx, ny, nz, mat);
  verts.push(p2x, p2y, p2z, nx, ny, nz, mat);
  verts.push(p3x, p3y, p3z, nx, ny, nz, mat);
  const b = base.v;
  idxs.push(b, b + 1, b + 2, b, b + 2, b + 3);
  base.v += 4;
}

function pushBox(
  verts: number[], idxs: number[], base: { v: number },
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  mat: number,
): void {
  pushQuad(verts, idxs, base, x1,y0,z0, x1,y1,z0, x1,y1,z1, x1,y0,z1,  1, 0, 0, mat); // +X
  pushQuad(verts, idxs, base, x0,y0,z1, x0,y1,z1, x0,y1,z0, x0,y0,z0, -1, 0, 0, mat); // -X
  pushQuad(verts, idxs, base, x0,y1,z0, x0,y1,z1, x1,y1,z1, x1,y1,z0,  0, 1, 0, mat); // +Y
  pushQuad(verts, idxs, base, x0,y0,z1, x0,y0,z0, x1,y0,z0, x1,y0,z1,  0,-1, 0, mat); // -Y
  pushQuad(verts, idxs, base, x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1,  0, 0, 1, mat); // +Z
  pushQuad(verts, idxs, base, x1,y0,z0, x0,y0,z0, x0,y1,z0, x1,y1,z0,  0, 0,-1, mat); // -Z
}

export function buildSceneMesh(bounds: WorldBounds, waterHeight: number, sites: Float64Array | null = null, siteColors: Uint8Array | null = null): SceneMesh {
  const halfX = bounds.sizeX / 2;
  const halfZ = bounds.sizeZ / 2;
  const h = bounds.sizeY;
  const t = 0.2; // frame beam thickness

  const oVerts: number[] = [];
  const oIdxs: number[] = [];
  const base = { v: 0 };

  // Volume: x in [-halfX, halfX], y in [0, h], z in [-halfZ, halfZ]
  // Frame beams sit just outside the volume.

  const xMin = -halfX;
  const xMax = halfX;
  const yMin = 0;
  const yMax = h;
  const zMin = -halfZ;
  const zMax = halfZ;

  const mat = Material.Frame;

  // 4 vertical (Y-direction) edges at corners
  pushBox(oVerts, oIdxs, base, xMax, yMin - t, zMax, xMax + t, yMax + t, zMax + t, mat);
  pushBox(oVerts, oIdxs, base, xMin - t, yMin - t, zMax, xMin, yMax + t, zMax + t, mat);
  pushBox(oVerts, oIdxs, base, xMax, yMin - t, zMin - t, xMax + t, yMax + t, zMin, mat);
  pushBox(oVerts, oIdxs, base, xMin - t, yMin - t, zMin - t, xMin, yMax + t, zMin, mat);

  // 4 X-direction edges at top
  pushBox(oVerts, oIdxs, base, xMin, yMax, zMax, xMax, yMax + t, zMax + t, mat);
  pushBox(oVerts, oIdxs, base, xMin, yMax, zMin - t, xMax, yMax + t, zMin, mat);
  // 4 X-direction edges at bottom
  pushBox(oVerts, oIdxs, base, xMin, yMin - t, zMax, xMax, yMin, zMax + t, mat);
  pushBox(oVerts, oIdxs, base, xMin, yMin - t, zMin - t, xMax, yMin, zMin, mat);

  // 4 Z-direction edges at top
  pushBox(oVerts, oIdxs, base, xMax, yMax, zMin, xMax + t, yMax + t, zMax, mat);
  pushBox(oVerts, oIdxs, base, xMin - t, yMax, zMin, xMin, yMax + t, zMax, mat);
  // 4 Z-direction edges at bottom
  pushBox(oVerts, oIdxs, base, xMax, yMin - t, zMin, xMax + t, yMin, zMax, mat);
  pushBox(oVerts, oIdxs, base, xMin - t, yMin - t, zMin, xMin, yMin, zMax, mat);

  // Voronoi site visualization — small boxes
  if (sites) {
    const s = 0.15; // half-size of 0.3³ box
    for (let i = 0; i < sites.length; i += 3) {
      const si = i / 3;
      const m = siteColors ? siteColors[si] : Material.Stone;
      const x = sites[i], y = sites[i + 1], z = sites[i + 2];
      pushBox(oVerts, oIdxs, base, x - s, y - s, z - s, x + s, y + s, z + s, m);
    }
  }

  // Water plane — large quad at waterHeight, extending well beyond the volume
  const waterExtent = 1024;
  const tVerts: number[] = [];
  const tIdxs: number[] = [];
  const wMat = Material.Water;
  // Single upward-facing quad
  tVerts.push(
    -waterExtent, waterHeight, -waterExtent, 0, 1, 0, wMat,
    -waterExtent, waterHeight,  waterExtent, 0, 1, 0, wMat,
     waterExtent, waterHeight,  waterExtent, 0, 1, 0, wMat,
     waterExtent, waterHeight, -waterExtent, 0, 1, 0, wMat,
  );
  tIdxs.push(0, 1, 2, 0, 2, 3);

  return {
    opaqueVertices: new Float32Array(oVerts),
    opaqueIndices: new Uint32Array(oIdxs),
    transparentVertices: new Float32Array(tVerts),
    transparentIndices: new Uint32Array(tIdxs),
  };
}
