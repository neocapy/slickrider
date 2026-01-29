**Claude: Every edit that changes the list of types, their public-facing methods, or performs any architectural changes must update this file too. Use this as your persistent memory.**

# Slick Rider

WebGPU game for Bigmode Game Jam 2026. Built with TypeScript + Vite.

## Architecture

One file per major type. `main.ts` is the entry point and does nothing but boot.

### `src/main.ts`

Entry point. Grabs DOM elements, calls `Game.create()`, displays errors.

### `src/game.ts` -- `Game`

Owns the WebGPU device, canvas, game loop, and `Renderer`. Private constructor; use `Game.create(canvas)`.

- `create()`: initializes WebGPU, creates `World`, runs `generateWorld`, builds mesh via `buildWorldMesh`, passes mesh to `Renderer`
- Loop: `requestAnimationFrame` -> `timing.update()` -> `onResize()` -> `update()` (includes `input.update()`) -> `render()`
- Owns `Input` instance; `update()` polls input and adjusts camera (yaw/height/distance)
- Camera defaults: height 60, distance 120, distances [80, 120, 200]
- `render()` delegates to `Renderer.render()`, then updates the debug overlay
- F2 toggles the debug overlay (a DOM div, styled in `index.html`)
- Handles window resize and DPR changes (forwards resize to renderer)

### `src/math.ts` -- Vec3, mat4 helpers

Column-major mat4 and Vec3 utilities for WebGPU (depth [0,1], column-major layout).

Exports:
- `Vec3` type (3-tuple)
- `vec3Sub`, `vec3Cross`, `vec3Dot`, `vec3Normalize`
- `mat4Identity()`, `mat4Perspective(fovY, aspect, near, far)`, `mat4LookAt(eye, target, up)`, `mat4Multiply(a, b)`

### `src/materials.ts` -- `Material`, `MaterialInfo`

Material enum and metadata. `Material`: Air(0), Water(1), Stone(2), Dirt(3), Grass(4), Concrete(5). `MATERIAL_COUNT = 6`. `MATERIAL_INFO` array with `name`, `isTransparent`, `isOpaque` per material.

### `src/textures.ts`

Generates a `texture_2d_array` (6 layers, each 16×16 RGBA8) with procedural patterns per material. Nearest-filtered sampler.

- `createMaterialTextureArray(device)` → `{ texture, sampler }`

### `src/world.ts` -- `World`

Voxel world data model. 64×64 base (X/Z ∈ [-32,+31]), 128 tall (Y ∈ [0,127]). Centered at world origin. `Uint8Array` storage with Y-major indexing.

- `inBounds(x, y, z)` -- bounds check in world coords
- `get(x, y, z)` -- returns `Material` (Air if out of bounds)
- `set(x, y, z, mat)` -- sets material

### `src/worldgen.ts`

Procedural world generation. Height map from smooth-unioned SDF circles with erosion. Layers: Stone (bulk), Dirt (sub-surface), Grass (top). Water fills air below Y=16. Concrete houses placed on flat surface spots.

- `generateWorld(world)` -- fills a `World` in-place

### `src/worldmesh.ts` -- `WorldMesh`

Converts `World` into GPU-ready mesh data. Two meshes: opaque and transparent. Face culling: skips faces between adjacent opaque blocks or adjacent water blocks.

Vertex format: 7 floats (28 bytes) — position(3) + normal(3) + materialIndex(1). No UVs (computed in shader from worldPos + normal).

- `VERTEX_FLOATS = 7`
- `buildWorldMesh(world)` → `WorldMesh { opaqueVertices, opaqueIndices, transparentVertices, transparentIndices }`

### `src/renderer.ts` -- `Renderer`

Owns all WebGPU rendering state. Two render pipelines (opaque + transparent), `texture_2d_array` for material textures, depth buffer.

Constructor: `new Renderer(device, format, mesh: WorldMesh)`.

Methods:
- `resize(w, h)` -- recreate depth texture
- `render(context, camera: { yaw, height, distance }, aspect)` -- encode and submit a frame

Opaque pipeline: backface culling, depth write on. Transparent pipeline: alpha blending (src-alpha), depth write off. Fragment shader computes UVs from world position projected onto face normal plane. Water rendered at alpha 0.5. Two directional lights + Fresnel rim lighting. Camera targets (0, 30, 0), far plane 500.

### `src/input.ts` -- `Input`, `Action`

Unified input system. Actions are analog floats (0.0–1.0). Keyboard snaps to 0/1; gamepad provides analog values. Merges keyboard + gamepad via `Math.max` per action.

Action enum: Up, Down, Left, Right, Jump, Pause.

Constructor: `new Input()` — attaches keyboard listeners to `window`, gamepad connect/disconnect listeners.

Methods:
- `update()` -- call once per frame. Snapshots previous state, rebuilds current from keyboard + gamepad polling.
- `value(action)` -- raw float 0.0–1.0
- `isPressed(action)` -- value >= 0.5
- `justPressed(action)` -- crossed above 0.5 this frame
- `justReleased(action)` -- crossed below 0.5 this frame

Keyboard: WASD + Space + Escape via keydown/keyup on window.
Gamepad: standard mapping -- A(0)=Jump, Start(9)=Pause, D-pad(12-15), left stick axes with deadzone 0.3.

### `src/timing.ts` -- `Timing`, `FrameTimeStats`

Frame-time measurement. Ring buffer of last 100 delta times.

Fields:
- `dt: number` -- current frame delta in seconds
- `totalTime: number` -- accumulated elapsed time in seconds

Methods:
- `update(timestampMs)` -- call once per frame with the rAF timestamp
- `stats(): FrameTimeStats` -- returns `{ min, max, median, p10, p90 }` (all in seconds)
