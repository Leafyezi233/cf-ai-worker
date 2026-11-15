interface ReadLifetimeOptions {
  signal: AbortSignal;
  release: () => void;
  error: string;
  totalMs: number;
  idleMs: number;
  headerMs?: number;
  onStop?: () => void;
}
interface ReadWaiter { reject: ((error: Error) => void) | undefined }

export class VideoReadLifecycle {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private waiter: ReadWaiter | undefined;
  private inFlight = 0;
  private cancelling = false;
  private released = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private total: ReturnType<typeof setTimeout> | undefined;
  stopped = false;

  constructor(private readonly options: ReadLifetimeOptions) {
    options.signal.addEventListener("abort", this.stop, { once: true });
    this.total = setTimeout(this.stop, options.totalMs);
    this.armIdle(options.headerMs);
    if (options.signal.aborted) this.stop();
  }

  armIdle(ms = this.options.idleMs): void {
    if (this.stopped) return;
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = setTimeout(this.stop, ms);
  }

  bind(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.stopped) controller.error(new Error(this.options.error));
    else this.controller = controller;
  }

  open<T>(start: () => Promise<T>, body: (value: T) => ReadableStream<Uint8Array> | null | undefined): Promise<T> {
    return this.wait(start, value => {
      const source = body(value);
      if (source) {
        this.reader = source.getReader();
        if (this.stopped) this.cancelReader();
      }
    });
  }

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const part = await this.wait(() => this.reader!.read());
    if (this.stopped) throw new Error(this.options.error);
    this.armIdle();
    return part;
  }

  private wait<T>(start: () => Promise<T>, adopt?: (value: T) => void): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(this.options.error));
    if (this.waiter || this.inFlight) return Promise.reject(new Error("video_read_already_pending"));
    this.inFlight++;
    return new Promise<T>((resolve, reject) => {
      const waiter: ReadWaiter = { reject };
      this.waiter = waiter;
      let deliver: ((value: T) => void) | undefined = resolve;
      let fail: ((error: Error) => void) | undefined = reject;
      waiter.reject = error => { deliver = undefined; const notify = fail; fail = undefined; notify?.(error); };
      const settle = (failure: boolean, value: T | unknown) => {
        try {
          if (!failure) adopt?.(value as T);
          if (failure) waiter.reject?.(value as Error);
          else deliver?.(value as T);
        } catch (error) { waiter.reject?.(error as Error); }
        finally {
          deliver = undefined;
          fail = undefined;
          waiter.reject = undefined;
          if (this.waiter === waiter) this.waiter = undefined;
          this.inFlight--;
          this.releaseIfSettled();
        }
      };
      try { void start().then(value => settle(false, value), error => settle(true, error)); }
      catch (error) { settle(true, error); }
    });
  }

  stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    const failure = new Error(this.options.error);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject?.(failure);
    if (waiter) waiter.reject = undefined;
    try { this.controller?.error(failure); } catch {   }
    this.controller = undefined;
    this.options.onStop?.();
    this.cancelReader();
    this.releaseIfSettled();
  };

  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.controller = undefined;
    this.releaseIfSettled();
  }

  private cleanup(): void {
    if (this.idle !== undefined) clearTimeout(this.idle);
    if (this.total !== undefined) clearTimeout(this.total);
    this.idle = this.total = undefined;
    this.options.signal.removeEventListener("abort", this.stop);
  }

  private cancelReader(): void {
    if (!this.reader || this.cancelling) return;
    this.cancelling = true;
    this.inFlight++;
    const settled = () => { this.inFlight--; this.releaseIfSettled(); };
    try { void this.reader.cancel().then(settled, settled); }
    catch { settled(); }
  }

  private releaseIfSettled(): void {
    if (!this.stopped || this.inFlight || this.released) return;
    this.released = true;
    try { this.reader?.releaseLock(); } catch {   }
    this.reader = undefined;
    this.options.release();
  }
}
