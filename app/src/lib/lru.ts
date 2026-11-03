// A small least-recently-used map: reading or writing a key makes it the newest,
// and the oldest go once there are more than `max`.

export class Lru<K, V> {
  private map = new Map<K, V>();

  constructor(
    readonly max: number,
    private onEvict?: (key: K, value: V) => void,
  ) {}

  get size() {
    return this.map.size;
  }

  has(key: K) {
    return this.map.has(key);
  }

  /** The value, made the newest. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** The value, without making it the newest. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const [oldest, v] = this.map.entries().next().value as [K, V];
      this.map.delete(oldest);
      this.onEvict?.(oldest, v);
    }
  }

  delete(key: K) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /** Oldest first. */
  keys() {
    return [...this.map.keys()];
  }
}
