**Claude: Every edit that changes the list of types, their public-facing methods, or performs any architectural changes must update this file too. Use this as your persistent memory.**

# Slick Rider

WebGPU game for Bigmode Game Jam 2026. Built with TypeScript + Vite.

## Architecture

One file per major type. `main.ts` is the entry point and does nothing but boot.

### `src/main.ts`

Entry point. Grabs DOM elements, calls `Game.create()`, displays errors.

### `src/game.ts` -- `Game`

Owns the WebGPU device, canvas, game loop, and `Renderer`. Private constructor; use `Game.create(canvas)`.

- Loop: `requestAnimationFrame` -> `timing.update()` -> `onResize()` -> `update()` (includes `input.update()`) -> `render()`
- Owns `Input` instance; `update()` polls input and adjusts camera (yaw/height/distance) for testing
- `render()` delegates to `Renderer.render()`, then updates the debug overlay
- F2 toggles the debug overlay (a DOM div, styled in `index.html`)
- Handles window resize and DPR changes (forwards resize to renderer)

### `src/math.ts` -- Vec3, mat4 helpers

Column-major mat4 and Vec3 utilities for WebGPU (depth [0,1], column-major layout).

Exports:
- `Vec3` type (3-tuple)
- `vec3Sub`, `vec3Cross`, `vec3Dot`, `vec3Normalize`
- `mat4Identity()`, `mat4Perspective(fovY, aspect, near, far)`, `mat4LookAt(eye, target, up)`, `mat4Multiply(a, b)`

### `src/renderer.ts` -- `Renderer`

Owns all WebGPU rendering state: pipeline, shaders, buffers, texture, depth buffer.

Constructor: `new Renderer(device, format)` -- builds pipeline and generates scene geometry.

Methods:
- `resize(w, h)` -- recreate depth texture
- `render(context, camera: { yaw, height, distance }, aspect)` -- encode and submit a frame

Scene: 30 random flat-shaded triangles + 1 smooth-shaded cylinder (no caps, 24 segments). All indexed draws. Two directional lights (sun + backlight) and Fresnel rim lighting. 16x16 nearest-sampled test texture (slate blue checkerboard with red-U / green-V tinting).

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
