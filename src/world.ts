import { Material } from "./materials";

export class World {
  static readonly SIZE_X = 64;
  static readonly SIZE_Y = 128;
  static readonly SIZE_Z = 64;
  static readonly HALF_X = 32;
  static readonly HALF_Z = 32;

  readonly data: Uint8Array;

  constructor() {
    this.data = new Uint8Array(World.SIZE_X * World.SIZE_Y * World.SIZE_Z);
    // Default is 0 = Air
  }

  private index(sx: number, sy: number, sz: number): number {
    return sy * World.SIZE_X * World.SIZE_Z + sz * World.SIZE_X + sx;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return (
      x >= -World.HALF_X && x < World.HALF_X &&
      y >= 0 && y < World.SIZE_Y &&
      z >= -World.HALF_Z && z < World.HALF_Z
    );
  }

  get(x: number, y: number, z: number): Material {
    if (!this.inBounds(x, y, z)) return Material.Air;
    return this.data[this.index(x + World.HALF_X, y, z + World.HALF_Z)];
  }

  set(x: number, y: number, z: number, mat: Material): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.index(x + World.HALF_X, y, z + World.HALF_Z)] = mat;
  }
}
