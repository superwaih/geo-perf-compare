// Frame-time monitor: detects lag (janky frames) and breaks (freezes) via requestAnimationFrame
// and the Long Tasks API. Same thresholds as the Rust implementation.
export const JANK_MS = 50;
export const FREEZE_MS = 250;

export interface Stats {
  fps: number; maxFrameMs: number; jankFrames: number; freezes: number;
  longTasks: number; longTaskMs: number; jsHeapMB: number | null; wasmMemMB: number | null;
}

export interface StressResult {
  durationMs: number; frames: number; avgFps: number; p95FrameMs: number;
  maxFrameMs: number; jankFrames: number; freezes: number;
}

export class FrameMonitor {
  private last = 0;
  private windowFrames: number[] = [];
  private windowStart = 0;
  private recording: number[] | null = null;
  jankFrames = 0; freezes = 0; longTasks = 0; longTaskMs = 0;

  start(onStats: (s: Stats) => void) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { this.longTasks++; this.longTaskMs += e.duration; }
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* long tasks API not supported */ }

    const loop = (ts: number) => {
      // Background tabs are throttled by the browser; those frames say nothing about the app.
      if (document.visibilityState !== "visible") {
        this.last = 0;
        this.windowFrames = [];
        return requestAnimationFrame(loop);
      }
      if (this.last) {
        const dt = ts - this.last;
        this.windowFrames.push(dt);
        this.recording?.push(dt);
        if (dt > FREEZE_MS) this.freezes++;
        else if (dt > JANK_MS) this.jankFrames++;
      } else this.windowStart = ts;
      this.last = ts;
      if (ts - this.windowStart >= 500) {
        const elapsed = ts - this.windowStart;
        const mem = (performance as any).memory;
        onStats({
          fps: (this.windowFrames.length * 1000) / elapsed,
          maxFrameMs: Math.max(0, ...this.windowFrames),
          jankFrames: this.jankFrames, freezes: this.freezes,
          longTasks: this.longTasks, longTaskMs: this.longTaskMs,
          jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
          wasmMemMB: null,
        });
        this.windowFrames = [];
        this.windowStart = ts;
      }
      return requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  beginRecording() { this.recording = []; }
  endRecording(durationMs: number): StressResult {
    const f = this.recording ?? [];
    this.recording = null;
    const sorted = [...f].sort((a, b) => a - b);
    return {
      durationMs, frames: f.length,
      avgFps: (f.length * 1000) / durationMs,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      maxFrameMs: sorted[sorted.length - 1] ?? 0,
      jankFrames: f.filter((d) => d > JANK_MS && d <= FREEZE_MS).length,
      freezes: f.filter((d) => d > FREEZE_MS).length,
    };
  }
}

/** Resolves after the browser has actually painted the current changes. */
export const afterPaint = () =>
  new Promise<number>((res) => requestAnimationFrame(() => setTimeout(() => res(performance.now()), 0)));
