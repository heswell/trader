/** Seeded PRNG (mulberry32) with the distributions the simulator needs. */
export class Random {
  #state: number;
  #spareNormal: number | undefined;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    const spare = this.#spareNormal;
    if (spare !== undefined) {
      this.#spareNormal = undefined;
      return spare;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.#spareNormal = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** Poisson sample (Knuth for small means, normal approximation above 30). */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 30) {
      return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
    }
    const limit = Math.exp(-mean);
    let k = 0;
    let p = this.next();
    while (p > limit) {
      k++;
      p *= this.next();
    }
    return k;
  }

  /** Derive an independent generator (e.g. one per instrument). */
  fork(salt: number): Random {
    return new Random((this.#state ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}
