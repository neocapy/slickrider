const BUFFER_SIZE = 100;

export interface FrameTimeStats {
  min: number;
  max: number;
  median: number;
  p10: number;
  p90: number;
}

export class Timing {
  private buffer: Float64Array;
  private index = 0;
  private count = 0;
  private lastTimestamp = 0;

  /** Delta time for the current frame, in seconds. */
  dt = 0;

  /** Total elapsed time, in seconds. */
  totalTime = 0;

  constructor() {
    this.buffer = new Float64Array(BUFFER_SIZE);
  }

  /** Call once per frame with the rAF timestamp (ms). */
  update(timestampMs: number) {
    if (this.lastTimestamp > 0) {
      this.dt = (timestampMs - this.lastTimestamp) / 1000;
    } else {
      this.dt = 0;
    }
    this.lastTimestamp = timestampMs;
    this.totalTime += this.dt;

    this.buffer[this.index] = this.dt;
    this.index = (this.index + 1) % BUFFER_SIZE;
    if (this.count < BUFFER_SIZE) this.count++;
  }

  /** Compute frame-time statistics over the recent buffer. */
  stats(): FrameTimeStats {
    if (this.count === 0) {
      return { min: 0, max: 0, median: 0, p10: 0, p90: 0 };
    }

    // Copy the valid portion and sort it.
    const sorted = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      sorted[i] = this.buffer[i];
    }
    sorted.sort();

    const percentile = (p: number) => {
      const k = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(k);
      const hi = Math.ceil(k);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (k - lo) * (sorted[hi] - sorted[lo]);
    };

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: percentile(50),
      p10: percentile(10),
      p90: percentile(90),
    };
  }
}
