**Claude: Every edit that changes the list of types, their public-facing methods, or performs any architectural changes must update this file too. Use this as your persistent memory.**

# Slick Rider

WebGPU game for Bigmode Game Jam 2026. Built with TypeScript + Vite.

## Architecture

One file per major type. `main.ts` is the entry point and does nothing but boot.

### `src/main.ts`

Entry point. Grabs DOM elements, calls `Game.create()`, displays errors.

### `src/game.ts` -- `Game`

Owns the WebGPU device, canvas, game loop, and `Renderer`. Private constructor; use `Game.create(canvas)`.

- `create()`: initializes WebGPU, creates `WorldBounds` + `waterHeight`, generates 16384 Voronoi sites, computes k-NN (k=30), builds Voronoi cells, marks cells with Y < waterHeight as solid ground (Stone), seeds ~20 floating regions in the sky via BFS flood-fill over knn adjacency (20-60 cells each, cycling Stone/Dirt/Grass/Concrete), extracts culled mesh with per-cell materials, passes to `Renderer`
- Loop: `requestAnimationFrame` -> `timing.update()` -> `onResize()` -> `update()` (includes `input.update()`) -> `render()`
- Owns `Input` instance; `update()` polls input for FPS camera movement and mouse look
- FPS camera: position (x, y, z), yaw, pitch. Defaults: position (0, 60, 0), yaw 0, pitch 0
- WASD moves in XZ plane relative to yaw, Q/E for debug vertical, mouse click+drag rotates. Speed 30 units/s, sensitivity 0.003
- `render()` delegates to `Renderer.render()`, then updates the debug overlay
- F2 toggles the debug overlay (a DOM div, styled in `index.html`)
- F3 toggles wireframe rendering mode
- `destroy()` -- cancels rAF, removes listeners, destroys input and renderer
- Handles window resize and DPR changes (forwards resize to renderer)
- Stores `bounds: WorldBounds` and `waterHeight: number` as instance fields (runtime-configurable)
- Default bounds: sizeX=256, sizeY=128, sizeZ=96. Default waterHeight=16.

### `src/math.ts` -- Vec3, mat4 helpers

Column-major mat4 and Vec3 utilities for WebGPU (depth [0,1], column-major layout).

Exports:
- `Vec3` type (3-tuple)
- `vec3Add`, `vec3Sub`, `vec3Scale`, `vec3Length`, `vec3Lerp`, `vec3Cross`, `vec3Dot`, `vec3Normalize`
- `mat4Identity()`, `mat4Perspective(fovY, aspect, near, far)`, `mat4LookAt(eye, target, up)`, `mat4Multiply(a, b)`

### `src/materials.ts` -- `Material`, `MaterialInfo`

Material enum and metadata. `Material`: Air(0), Water(1), Stone(2), Dirt(3), Grass(4), Concrete(5), Frame(6). `MATERIAL_COUNT = 7`. `MATERIAL_INFO` array with `name`, `isTransparent`, `isOpaque` per material.

### `src/textures.ts`

Generates a `texture_2d_array` (7 layers, each 16x16 RGBA8) with procedural patterns per material. Nearest-filtered sampler. Frame material is pitch black.

- `createMaterialTextureArray(device)` -> `{ texture, sampler }`

### `src/scenemesh.ts` -- `WorldBounds`, `SceneMesh`

Builds GPU-ready mesh from world bounds configuration (no voxels). Produces opaque geometry (frame edges) and transparent geometry (water plane).

- `WorldBounds` interface: `{ sizeX, sizeY, sizeZ }` (runtime-configurable)
- `SceneMesh` interface: `{ opaqueVertices, opaqueIndices, transparentVertices, transparentIndices }`
- `VERTEX_FLOATS = 7`
- `buildSceneMesh(bounds, waterHeight, sites?, siteColors?, extraOpaque?)` -> `SceneMesh` — optional `sites` adds 0.3³ boxes, `siteColors` sets per-site material, `extraOpaque: { vertices, indices }` merges additional opaque geometry

**Frame:** 12 thin boxes (0.2m thickness) forming the edges of the world volume, positioned just outside the volume boundary. Uses `Frame` material (pitch black).

**Water plane:** Single large quad at `waterHeight`, extending to +/-1024 in XZ. Uses `Water` material. Rendered as transparent geometry through the water pass.

### `src/voronoi.ts` -- `SpatialGrid`, `generateVoronoiSites`, `computeKNN`

Point generation with minimum-distance rejection and k-nearest-neighbor search, both using a spatial grid.

- `SpatialGrid` class (exported): 3D bucket structure. Constructor takes `WorldBounds` + target bucket count. `side` field is readonly. Methods: `insert(point, index)`, `nearbyIndices(point, radius): number[]`.
- `generateVoronoiSites(bounds, count, minDistance?)` -> `Float64Array` (flat xyz triples). Default minDistance: `cbrt(volume/count) * 0.3`. Uses rejection sampling with max `count * 20` attempts.
- `computeKNN(sites, bounds, k)` -> `Uint32Array` (flat `n × k`). For site `i`, neighbors at `i*k .. i*k+k-1`, sorted nearest-first. Uses expanding-radius grid queries with max-heap replacement.

### `src/convexcell.ts` -- `ConvexCell`, `buildVoronoiCells`, `extractVoronoiMesh`

3D Voronoi cell construction via iterative half-space clipping (Ray et al. 2018).

- `ConvexCell` class: dual representation (planes P + triangles T of plane indices). No explicit vertex storage — positions computed by intersecting 3 planes.
  - `ConvexCell.fromBoundingBox(xMin, xMax, yMin, yMax, zMin, zMax)` — creates cell with 6 planes, 12 dual triangles
  - `clipByPlane(plane, neighborIdx)` — clips cell by half-space, tracks which neighbor produced each plane. Returns false if degenerate.
  - `vertexPosition(triIdx)` — computes 3D point from 3-plane intersection
  - `securityRadius(sx, sy, sz)` — max distance from point to any vertex; if a candidate neighbor is farther than 2× this, it cannot clip the cell
  - `extractFaces()` — returns `{ vertices, neighbor, planeIdx }[]` with vertices ordered by angle
  - `neighborOf: Int32Array` — per-plane: site index that produced it (-1 = bounding box)
- `buildVoronoiCells(sites, knn, k, bounds, xMin, xMax, yMin, yMax, zMin, zMax)` -> `ConvexCell[]` — builds all cells with interleaved security radius check. Phase 1: clips knn neighbors nearest-first, rechecking security radius every 4 clips for early-out. Phase 2: if not proven secure, queries spatial grid within 2×radius for missing neighbors. Guarantees all true Voronoi neighbors are clipped.
- `extractVoronoiMesh(cells, solid, material: number | Uint8Array)` -> `{ vertices, indices }` — extracts renderable mesh with internal face culling. Only emits faces where `solid[i] != solid[neighbor]`. Boundary faces (neighbor = -1) only render if cell is solid. Material can be a single value or per-cell array.

### `src/renderer.ts` -- `Renderer`

Owns all WebGPU rendering state. 3-pass depth-peeling renderer for water transparency. Uses `depth32float` format (required for sampling depth as texture).

Constructor: `new Renderer(device, format, mesh: SceneMesh)`.

Methods:
- `destroy()` -- destroys all GPU buffers and textures
- `resize(w, h)` -- recreate 4 offscreen textures + rebuild bind groups
- `render(context, camera: { eye: Vec3, yaw, pitch }, aspect, wireframe)` -- encode and submit 3 render passes (or wireframe passes when flag is true)

**3-pass pipeline:**
1. **Opaque pass** -> renders opaque geometry to offscreen `opaqueColor` + `opaqueDepth`
2. **Water pass** -> renders water to `waterColor` + `waterDepth`, with manual depth test against `opaqueDepth` (discards fragments behind opaque geometry). Depth write ON, cull none.
3. **Composite pass** -> fullscreen triangle (no vertex buffer). Samples all 4 textures, linearizes depths, computes water thickness, blends with depth-dependent tint and alpha.

**Offscreen textures** (created in `resize()`):
- `opaqueColor` -- canvas format, RENDER_ATTACHMENT + TEXTURE_BINDING
- `opaqueDepth` -- depth32float, RENDER_ATTACHMENT + TEXTURE_BINDING
- `waterColor` -- canvas format, RENDER_ATTACHMENT + TEXTURE_BINDING
- `waterDepth` -- depth32float, RENDER_ATTACHMENT + TEXTURE_BINDING

**Bind groups:**
- Group 0 (shared, opaque+water): uniforms + material sampler + material texture array
- Group 1 (water pass): opaqueDepth (recreated on resize)
- Group 0 (composite): compositeUniforms (near/far) + all 4 offscreen textures (recreated on resize)

Shaders: 4 WGSL strings (OPAQUE_SHADER, WATER_SHADER, COMPOSITE_SHADER, WIREFRAME_SHADER). Two directional lights + Fresnel rim lighting. Camera target computed from eye + forward(yaw, pitch), near 0.1, far 1000.

**Wireframe mode:** When `wireframe` flag is true, skips the 3-pass pipeline. Two passes: (1) Depth pre-pass renders solid triangles (both opaque + transparent) with color writes off to populate depth buffer, clears color to white. (2) Wireframe pass loads existing depth, draws back lines (depthCompare greater, alpha 0.3 black) then front lines (depthCompare less-equal, solid black). Neither wireframe pass writes depth. Wireframe index buffers convert each quad's 6 triangle indices into 8 line indices (4 edges).

### `src/input.ts` -- `Input`, `Action`

Unified input system. Actions are analog floats (0.0-1.0). Keyboard snaps to 0/1; gamepad provides analog values. Merges keyboard + gamepad via `Math.max` per action.

Action enum: Up, Down, Left, Right, Jump, Pause, DebugMoveUp, DebugMoveDown.

Constructor: `new Input()` -- attaches keyboard, gamepad, and mouse listeners to `window`.

Methods:
- `destroy()` -- removes all window event listeners
- `update()` -- call once per frame. Snapshots previous state, rebuilds current from keyboard + gamepad polling. Snapshots and resets mouse delta.
- `value(action)` -- raw float 0.0-1.0
- `isPressed(action)` -- value >= 0.5
- `justPressed(action)` -- crossed above 0.5 this frame
- `justReleased(action)` -- crossed below 0.5 this frame
- `mouseDelta()` -- returns `[dx, dy]` pixel delta from mouse drag this frame

Keyboard: WASD + QE + Space + Escape via keydown/keyup on window.
Mouse: click+drag accumulates movementX/Y, returned via `mouseDelta()` each frame.
Gamepad: standard mapping -- A(0)=Jump, Start(9)=Pause, D-pad(12-15), left stick axes with deadzone 0.3.

### `src/timing.ts` -- `Timing`, `FrameTimeStats`

Frame-time measurement. Ring buffer of last 100 delta times.

Fields:
- `dt: number` -- current frame delta in seconds
- `totalTime: number` -- accumulated elapsed time in seconds

Methods:
- `update(timestampMs)` -- call once per frame with the rAF timestamp
- `stats(): FrameTimeStats` -- returns `{ min, max, median, p10, p90 }` (all in seconds)
