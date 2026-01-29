export enum Material {
  Air = 0,
  Water = 1,
  Stone = 2,
  Dirt = 3,
  Grass = 4,
  Concrete = 5,
}

export const MATERIAL_COUNT = 6;

export interface MaterialInfo {
  name: string;
  isTransparent: boolean;
  isOpaque: boolean;
}

export const MATERIAL_INFO: MaterialInfo[] = [
  { name: "Air",      isTransparent: true,  isOpaque: false },
  { name: "Water",    isTransparent: true,  isOpaque: false },
  { name: "Stone",    isTransparent: false, isOpaque: true  },
  { name: "Dirt",     isTransparent: false, isOpaque: true  },
  { name: "Grass",    isTransparent: false, isOpaque: true  },
  { name: "Concrete", isTransparent: false, isOpaque: true  },
];
