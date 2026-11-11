// One request at a time; generation guards prevent late responses from reviving
// a stopped source (for example after switching to sample data).
export class LiveResults {
  constructor({ fetchResults, onData, onError, visible = () => true, interval = 5000,
    schedule = (fn, delay) => setTimeout(fn, delay), cancel = timer => clearTimeout(timer) }) {
    Object.assign(this, { fetchResults, onData, onError, visible, interval, schedule, cancel });
    this.generation = 0;
  }
  start({ immediate = false } = {}) {
    this.stop(); this.running = true;
    if (immediate) void this.tick(this.generation); else this.queue(this.generation);
  }
  stop() {
    this.running = false; this.generation++;
    this.cancel(this.timer); this.controller?.abort(); this.controller = null;
  }
  queue(generation) {
    if (this.running && generation === this.generation) this.timer = this.schedule(() => this.tick(generation), this.interval);
  }
  refresh() {
    if (!this.running || this.controller) return;
    this.cancel(this.timer); void this.tick(this.generation);
  }
  async tick(generation) {
    if (!this.running || generation !== this.generation) return;
    if (!this.visible()) { this.queue(generation); return; }
    const controller = new AbortController(); this.controller = controller;
    try {
      const data = await this.fetchResults(controller.signal);
      if (this.running && generation === this.generation) this.onData(data);
    } catch (error) {
      if (this.running && generation === this.generation) this.onError(error);
    } finally {
      if (this.controller === controller) this.controller = null;
      this.queue(generation);
    }
  }
}
