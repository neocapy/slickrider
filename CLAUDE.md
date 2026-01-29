**Claude: Every edit that changes the list of types, their public-facing methods, or performs any architectural changes must update this file too. Use this as your persistent memory.**

# Slick Rider

WebGPU game for Bigmode Game Jam 2026. Built with TypeScript + Vite.

## Architecture

One file per major type. `main.ts` is the entry point and does nothing but boot.

### `src/main.ts`

Entry point. Grabs DOM elements, calls `Game.create()`, displays errors.

### `src/game.ts` -- `Game`

Owns the WebGPU device, canvas, and game loop. Private constructor; use `Game.create(canvas)`.

- Loop: `requestAnimationFrame` -> `timing.update()` -> `onResize()` -> `update()` -> `render()`
- F2 toggles the debug overlay (a DOM div, styled in `index.html`)
- Handles window resize and DPR changes

### `src/timing.ts` -- `Timing`, `FrameTimeStats`

Frame-time measurement. Ring buffer of last 100 delta times.

Fields:
- `dt: number` -- current frame delta in seconds
- `totalTime: number` -- accumulated elapsed time in seconds

Methods:
- `update(timestampMs)` -- call once per frame with the rAF timestamp
- `stats(): FrameTimeStats` -- returns `{ min, max, median, p10, p90 }` (all in seconds)
