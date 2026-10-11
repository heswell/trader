/**
 * Fixed-capacity FIFO of row keys. `push` returns the key evicted to make
 * room, so the caller can delete that row from its table.
 */
export class TradeRingBuffer {
  readonly #keys: (string | undefined)[];
  #head = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    if (!(capacity > 0)) throw Error("TradeRingBuffer capacity must be > 0");
    this.#keys = new Array(capacity);
  }

  get size() {
    return this.#size;
  }

  push(key: string): string | undefined {
    const tail = (this.#head + this.#size) % this.capacity;
    if (this.#size < this.capacity) {
      this.#keys[tail] = key;
      this.#size++;
      return undefined;
    }
    const evicted = this.#keys[this.#head];
    this.#keys[this.#head] = key;
    this.#head = (this.#head + 1) % this.capacity;
    return evicted;
  }

  /** Oldest first. */
  toArray(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.#size; i++) {
      out.push(this.#keys[(this.#head + i) % this.capacity] as string);
    }
    return out;
  }
}
