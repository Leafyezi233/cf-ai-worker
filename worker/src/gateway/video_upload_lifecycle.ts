export class VideoUploadLifetime {
  private stopped: Error | null = null;
  private waiters = new Set<(error: Error) => void>();
  private stops = new Set<() => void>();
  private pending = 0;
  private returned = false;
  private released = false;
  private timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.stop(this.interrupted());

  constructor(private signal: AbortSignal, private release: () => void,
    private timeout: () => Error, private interrupted: () => Error, ms = 60_000) {
    this.timer = setTimeout(() => this.stop(this.timeout()), ms);
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.stop(this.interrupted());
  }
  get error(): Error | null { return this.stopped; }
  check(): void { if (this.stopped) throw this.stopped; }
  onStop(action: () => void): () => void {
    if (this.stopped) { action(); return () => {}; }
    this.stops.add(action); return () => { this.stops.delete(action); };
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.pending++;
    void work.then(() => this.settled(), () => this.settled());
    return work;
  }
  private settled(): void { this.pending--; this.tryRelease(); }
  private tryRelease(): void {
    if (this.returned && this.pending === 0 && !this.released) { this.released = true; this.release(); }
  }
  wait<T>(work: Promise<T>): Promise<T> {
    if (this.stopped) { void work.catch(() => {}); return Promise.reject(this.stopped); }
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const stop = (error: Error) => { if (!done) { done = true; this.waiters.delete(stop); reject(error); } };
      this.waiters.add(stop);
      void work.then(value => { if (!done) { done = true; this.waiters.delete(stop); resolve(value); } },
        error => { if (!done) { done = true; this.waiters.delete(stop); reject(error); } });
    });
  }
  stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = error; this.dispose();
    for (const reject of this.waiters) reject(error);
    this.waiters.clear();
    for (const action of this.stops) { try { action(); } catch {   } }
    this.stops.clear();
  }
  private dispose(): void { clearTimeout(this.timer); this.signal.removeEventListener("abort", this.onAbort); }
  returnedResponse(): void {
    this.returned = true; this.dispose(); this.stops.clear(); this.tryRelease();
  }
}
