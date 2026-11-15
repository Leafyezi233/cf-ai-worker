export class BoundedWindow {
  private entries = new Map<string, number[]>();
  private count = 0;
  private sweep: Iterator<[string, number[]]> | undefined;
  constructor(readonly maxKeys = 4096, readonly maxStamps = 65536) {}
  private prune(key: string, values: number[], now: number): number[] {
    const live = values.filter(t => t > now - 60000);
    this.count -= values.length - live.length;
    if (live.length) this.entries.set(key, live); else this.entries.delete(key);
    return live;
  }
  hit(key: string, rpm: number, now = Date.now()): boolean {
    if (!Number.isFinite(rpm) || rpm <= 0) return true;
    for (let i=0;i<32;i++) {
      this.sweep ??= this.entries.entries();
      const next = this.sweep.next();
      if (next.done) { this.sweep = undefined; break; }
      this.prune(next.value[0],next.value[1],now);
    }
    const values = this.prune(key,this.entries.get(key) || [],now);
    if (values.length >= rpm || this.count >= this.maxStamps || (!values.length && this.entries.size >= this.maxKeys)) return false;
    values.push(now); this.entries.set(key,values); this.count++;
    return true;
  }
  undo(key: string, now: number): void {
    const values = this.entries.get(key); if (!values) return;
    const i = values.lastIndexOf(now); if (i < 0) return;
    values.splice(i,1); this.count--; if (!values.length) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); this.count = 0; this.sweep = undefined; }
  get size(): number { return this.entries.size; }
  get stamps(): number { return this.count; }
}
