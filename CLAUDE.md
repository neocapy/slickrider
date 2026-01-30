**Claude: Every edit that changes the list of types, their public-facing methods, or performs any architectural changes must update this file too. Use this as your persistent memory.**

# Slick Rider

WebGPU game for Bigmode Game Jam 2026. Built with TypeScript + Vite.

## Architecture

One file per major type. `main.ts` is the entry point and does nothing but boot.

### `src/main.ts`

Entry point. Grabs DOM elements, calls `Game.create()`, displays errors.

### `src/game.ts` -- `Game`

Owns the WebGPU device, canvas, game loop, and `Renderer`. Private constructor; use `Game.create(canvas)`.

- `create()`: initializes WebGPU, creates `WorldBounds` + `waterHeight`, builds mesh via `buildSceneMesh`, passes mesh to `Renderer`
- Loop: `requestAnimationFrame` -> `timing.update()` -> `onResize()` -> `update()` (includes `input.update()`) -> `render()`
- Owns `Input` instance; `update()` polls input and adjusts camera (yaw/height/distance)
- Camera defaults: height 60, distance 120, distances [80, 120, 200]
- `render()` delegates to `Renderer.render()`, then updates the debug overlay
- F2 toggles the debug overlay (a DOM div, styled in `index.html`)
- F3 toggles wireframe rendering mode
- `destroy()` -- cancels rAF, removes listeners, destroys input and renderer
- Handles window resize and DPR changes (forwards resize to renderer)
- Stores `bounds: WorldBounds` and `waterHeight: number` as instance fields (runtime-configurable)
- Default bounds: sizeX=64, sizeY=128, sizeZ=64. Default waterHeight=16.

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
- `buildSceneMesh(bounds, waterHeight)` -> `SceneMesh`

**Frame:** 12 thin boxes (0.2m thickness) forming the edges of the world volume, positioned just outside the volume boundary. Uses `Frame` material (pitch black).

**Water plane:** Single large quad at `waterHeight`, extending to +/-1024 in XZ. Uses `Water` material. Rendered as transparent geometry through the water pass.

### `src/renderer.ts` -- `Renderer`

Owns all WebGPU rendering state. 3-pass depth-peeling renderer for water transparency. Uses `depth32float` format (required for sampling depth as texture).

Constructor: `new Renderer(device, format, mesh: SceneMesh)`.

Methods:
- `destroy()` -- destroys all GPU buffers and textures
- `resize(w, h)` -- recreate 4 offscreen textures + rebuild bind groups
- `render(context, camera: { yaw, height, distance }, aspect)` -- encode and submit 3 render passes

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

Shaders: 4 WGSL strings (OPAQUE_SHADER, WATER_SHADER, COMPOSITE_SHADER, WIREFRAME_SHADER). Two directional lights + Fresnel rim lighting. Camera targets (0, 30, 0), near 0.1, far 500.

**Wireframe mode:** When `wireframe` flag is true, skips the 3-pass pipeline. Two passes: (1) Depth pre-pass renders solid triangles (both opaque + transparent) with color writes off to populate depth buffer, clears color to white. (2) Wireframe pass loads existing depth, draws back lines (depthCompare greater, alpha 0.3 black) then front lines (depthCompare less-equal, solid black). Neither wireframe pass writes depth. Wireframe index buffers convert each quad's 6 triangle indices into 8 line indices (4 edges).

### `src/input.ts` -- `Input`, `Action`

Unified input system. Actions are analog floats (0.0-1.0). Keyboard snaps to 0/1; gamepad provides analog values. Merges keyboard + gamepad via `Math.max` per action.

Action enum: Up, Down, Left, Right, Jump, Pause.

Constructor: `new Input()` -- attaches keyboard listeners to `window`, gamepad connect/disconnect listeners.

Methods:
- `destroy()` -- removes all window event listeners
- `update()` -- call once per frame. Snapshots previous state, rebuilds current from keyboard + gamepad polling.
- `value(action)` -- raw float 0.0-1.0
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
