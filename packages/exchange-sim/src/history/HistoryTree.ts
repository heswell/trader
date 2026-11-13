import { Random } from "../util/random";
import type { BucketValue } from "./BucketWindow";

/** One mean-reverting (Ornstein-Uhlenbeck) component, in log space. */
export interface OuComponent {
  /** Stationary variance. */
  variance: number;
  /** Mean reversion per ms: random-walk-like over spans well under 1 / theta. */
  theta: number;
}

/**
 * The model a tree is generated with: `level` plus a sum of independent OU
 * components (log space), e.g. a slow one for trends over months and a fast
 * one for the intraday wiggle. Each component diffuses at
 * `2 * theta * variance` per ms over short spans and settles to its variance
 * over long ones, so the whole wanders by at most about the square root of
 * the summed variances.
 */
export interface OuParams {
  /** Long-run mean (log value). */
  level: number;
  components: OuComponent[];
}

export interface HistoryTreeOptions {
  /** Point interval (ms): level 0 buckets hold one point. */
  baseMs: number;
  /** Level of the coarsest (generated) buckets: width `baseMs * 2^topLevel`. */
  topLevel: number;
  /** First point; aligned down to the top width. */
  start: number;
  /** Exclusive end, aligned to the top width: the next point is `endValue`. */
  end: number;
  /** Log value at `end` (the first point after the tree). */
  endValue: number;
  params: OuParams;
  seed: number;
  /** Nodes cached before the older half is dropped. */
  cacheLimit?: number;
}

/** M4 of one bucket, in log values; first is at the bucket start, last at its end - baseMs. */
interface TreeNode {
  first: number;
  last: number;
  min: number;
  minT: number;
  max: number;
  maxT: number;
}

const DEFAULT_CACHE_LIMIT = 200_000;

const hashSeed = (seed: number, level: number, index: number) => {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0;
    h ^= h >>> 13;
  };
  mix(level);
  mix(index % 4294967296);
  mix(Math.floor(index / 4294967296));
  return h;
};

/**
 * Procedural history at every resolution, generated on demand. The top level
 * (about a day per bucket) is generated whole as M4 buckets of a walk of the
 * model backwards from `endValue`. Any finer bucket is made by splitting its
 * parent in two, with the parent's first / min / max / last pinned: the two
 * new boundary points come from a bridge between the pinned points, and
 * each child's missing extreme is sampled from the bridge extreme
 * distribution, strictly inside the parent's range. So the children's M4
 * always merge back to exactly the parent's: zooming in adds detail but never
 * moves the line drawn at a coarser width. Each split is seeded by its node,
 * so a bucket regenerates identically and only a cache is kept.
 */
export class HistoryTree {
  readonly baseMs: number;
  readonly topLevel: number;
  readonly topWidth: number;
  readonly start: number;
  readonly end: number;
  readonly params: OuParams;
  readonly #seed: number;
  readonly #cacheLimit: number;
  readonly #top: TreeNode[];
  #cache = new Map<number, TreeNode>();
  #older = new Map<number, TreeNode>();
  /** Nodes split since construction (for stats). */
  refinements = 0;

  constructor(options: HistoryTreeOptions) {
    const { baseMs, topLevel } = options;
    this.baseMs = baseMs;
    this.topLevel = topLevel;
    this.topWidth = baseMs * 2 ** topLevel;
    this.end = Math.floor(options.end / this.topWidth) * this.topWidth;
    this.start =
      Math.floor(Math.min(options.start, this.end) / this.topWidth) *
      this.topWidth;
    this.params = options.params;
    this.#seed = options.seed >>> 0;
    this.#cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
    this.#top = this.#generateTop(options.endValue);
  }

  /** Points covered. */
  get length() {
    return (this.end - this.start) / this.baseMs;
  }

  get cacheSize() {
    return this.#cache.size + this.#older.size;
  }

  // ---- the model ---------------------------------------------------------

  /** Semivariogram: half the variance of the change over `dt` ms. */
  #gamma(dt: number) {
    let g = 0;
    for (const { variance, theta } of this.params.components)
      g += variance * -Math.expm1(-theta * dt);
    return g;
  }

  /**
   * Sample x(t) given x(ta) = a and x(tb) = b (ta < t < tb), from the
   * increments' covariance (the pull towards `level` inside one bridge is
   * left out: it only matters over spans that are already pinned above).
   */
  #bridge(ta: number, a: number, tb: number, b: number, t: number) {
    const gl = this.#gamma(t - ta);
    const gr = this.#gamma(tb - t);
    const gT = this.#gamma(tb - ta);
    const varW = 2 * gT;
    const cov = gl + gT - gr;
    const mean = a + (cov / varW) * (b - a);
    const v = 2 * gl - (cov * cov) / varW;
    return { mean, sd: Math.sqrt(Math.max(0, v)) };
  }

  /**
   * The lowest (dir -1) or highest (dir 1) value of a bridge from a to b over
   * `dt` ms: the Brownian bridge extreme with the model's increment variance,
   * widened where a component reverts within `dt` (it keeps making new
   * extremes).
   */
  #extreme(a: number, b: number, dt: number, dir: 1 | -1, rng: Random) {
    let v = 0;
    for (const { variance, theta } of this.params.components)
      v +=
        2 * variance * -Math.expm1(-theta * dt) * (1 + Math.log1p(theta * dt));
    const u = 1 - rng.next(); // (0, 1]
    const d = b - a;
    return (a + b + dir * Math.sqrt(d * d - 2 * v * Math.log(u))) / 2;
  }

  // ---- generation --------------------------------------------------------

  #generateTop(endValue: number): TreeNode[] {
    const W = this.topWidth;
    const { baseMs } = this;
    const count = (this.end - this.start) / W;
    const rng = new Random(hashSeed(this.#seed, 99, 0));
    const top: TreeNode[] = new Array(count);
    const { level, components } = this.params;
    // the components' deviations, walked backwards (an OU is time-reversible);
    // today's deviation from level is shared out by variance
    const total = components.reduce((sum, c) => sum + c.variance, 0) || 1;
    const ys = components.map((c) => ((endValue - level) * c.variance) / total);
    const step = (dt: number) => {
      let x = level;
      components.forEach(({ variance, theta }, k) => {
        ys[k] =
          ys[k] * Math.exp(-theta * dt) +
          Math.sqrt(variance * -Math.expm1(-2 * theta * dt)) * rng.normal();
        x += ys[k];
      });
      return x;
    };
    for (let i = count - 1; i >= 0; i--) {
      const s = this.start + i * W;
      const last = step(baseMs);
      const first = step(W - baseMs);
      const ts = [s, s + W - baseMs];
      const vs = [first, last];
      const node: TreeNode = {
        first,
        last,
        min: 0,
        minT: 0,
        max: 0,
        maxT: 0,
      };
      const lo = this.#sampleExtreme(ts, vs, -1, -Infinity, Infinity, -1, rng);
      node.min = lo.v;
      node.minT = lo.t;
      const hi = this.#sampleExtreme(ts, vs, 1, -Infinity, Infinity, lo.t, rng);
      node.max = hi.v;
      node.maxT = hi.t;
      top[i] = node;
    }
    return top;
  }

  /**
   * The extreme of a child (pinned points `ts` / `vs`, sorted): the most
   * extreme pinned value, or a new point inside one of the gaps between
   * pinned points if a sampled bridge extreme goes further. New values stay
   * strictly inside (lo, hi); `exclude` is a time not to use.
   */
  #sampleExtreme(
    ts: number[],
    vs: number[],
    dir: 1 | -1,
    lo: number,
    hi: number,
    exclude: number,
    rng: Random,
  ) {
    const { baseMs } = this;
    let bt = ts[0];
    let bv = vs[0];
    for (let i = 1; i < ts.length; i++)
      if (dir * (vs[i] - bv) > 0) {
        bv = vs[i];
        bt = ts[i];
      }
    for (let i = 0; i + 1 < ts.length; i++) {
      const interior = (ts[i + 1] - ts[i]) / baseMs - 1;
      if (interior < 1) continue;
      const a = vs[i];
      const b = vs[i + 1];
      let e = this.#extreme(a, b, ts[i + 1] - ts[i], dir, rng);
      const near = dir < 0 ? Math.min(a, b) : Math.max(a, b);
      const bound = dir < 0 ? lo : hi;
      if (dir * (e - bound) >= 0)
        e = bound + (near - bound) * (0.05 + 0.9 * rng.next());
      if (!(dir * (e - bv) > 0)) continue;
      let k = 1 + Math.floor(rng.next() * interior);
      let t = ts[i] + k * baseMs;
      if (t === exclude) {
        if (interior < 2) continue;
        k = k === interior ? k - 1 : k + 1;
        t = ts[i] + k * baseMs;
      }
      bv = e;
      bt = t;
    }
    return { t: bt, v: bv };
  }

  /** Split a node of `level` (≥ 1) starting at `s` into its two children. */
  #refine(node: TreeNode, level: number, s: number): [TreeNode, TreeNode] {
    this.refinements++;
    const { baseMs } = this;
    const W = baseMs * 2 ** level;
    const rng = new Random(hashSeed(this.#seed, level, s / W));
    const lastT = s + W - baseMs;
    // pinned points, sorted by time, unique
    const ts: number[] = [];
    const vs: number[] = [];
    const pin = (t: number, v: number) => {
      let i = ts.length;
      while (i > 0 && ts[i - 1] > t) i--;
      if (i > 0 && ts[i - 1] === t) return;
      ts.splice(i, 0, t);
      vs.splice(i, 0, v);
    };
    pin(s, node.first);
    pin(node.minT, node.min);
    pin(node.maxT, node.max);
    pin(lastT, node.last);
    const { min, max } = node;
    const span = max - min;
    const m = s + W / 2;
    for (const t of [m - baseMs, m]) {
      let i = 0;
      while (ts[i] < t) i++;
      if (ts[i] === t) continue;
      const { mean, sd } = this.#bridge(ts[i - 1], vs[i - 1], ts[i], vs[i], t);
      let v: number;
      if (!(span > 0)) v = min;
      else {
        const eps = span * 1e-6;
        const centre = Math.min(max - eps, Math.max(min + eps, mean));
        v = centre + sd * rng.normal();
        if (v >= max) v = centre + (max - centre) * (0.05 + 0.9 * rng.next());
        else if (v <= min)
          v = centre - (centre - min) * (0.05 + 0.9 * rng.next());
      }
      ts.splice(i, 0, t);
      vs.splice(i, 0, v);
    }
    const children = [s, m].map((cs) => {
      const ce = cs + W / 2;
      const cts: number[] = [];
      const cvs: number[] = [];
      for (let i = 0; i < ts.length; i++)
        if (ts[i] >= cs && ts[i] < ce) {
          cts.push(ts[i]);
          cvs.push(vs[i]);
        }
      const child: TreeNode = {
        first: cvs[0],
        last: cvs[cvs.length - 1],
        min: 0,
        minT: 0,
        max: 0,
        maxT: 0,
      };
      if (node.minT >= cs && node.minT < ce) {
        child.min = min;
        child.minT = node.minT;
      } else {
        const e = this.#sampleExtreme(cts, cvs, -1, min, max, -1, rng);
        child.min = e.v;
        child.minT = e.t;
      }
      if (node.maxT >= cs && node.maxT < ce) {
        child.max = max;
        child.maxT = node.maxT;
      } else {
        const e = this.#sampleExtreme(cts, cvs, 1, min, max, child.minT, rng);
        child.max = e.v;
        child.maxT = e.t;
      }
      return child;
    });
    return children as [TreeNode, TreeNode];
  }

  #remember(key: number, node: TreeNode) {
    if (this.#cache.size >= this.#cacheLimit / 2) {
      this.#older = this.#cache;
      this.#cache = new Map();
    }
    this.#cache.set(key, node);
  }

  /** The node of `level` (≤ topLevel) whose bucket starts at `s` (inside the tree). */
  node(level: number, s: number): TreeNode {
    if (level === this.topLevel)
      return this.#top[(s - this.start) / this.topWidth];
    const W = this.baseMs * 2 ** level;
    const key = (s / W) * 64 + level;
    const hit = this.#cache.get(key) ?? this.#older.get(key);
    if (hit) return hit;
    const ps = Math.floor(s / (2 * W)) * 2 * W;
    const [left, right] = this.#refine(this.node(level + 1, ps), level + 1, ps);
    this.#remember((ps / W) * 64 + level, left);
    this.#remember((ps / W + 1) * 64 + level, right);
    return s === ps ? left : right;
  }

  // ---- queries -------------------------------------------------------------

  /**
   * Every bucket of `width` (baseMs × 2^k) in `[from, to)` that holds tree
   * points, as BucketValues with `toValue` applied (exp for log series). A
   * bucket wider than the top level merges top buckets, and may be partial at
   * the tree's start or end.
   */
  bucketsIn(
    from: number,
    to: number,
    width: number,
    toValue: (x: number) => number,
    out: BucketValue[] = [],
  ) {
    const level = Math.round(Math.log2(width / this.baseMs));
    const lo = Math.max(from, this.start);
    const hi = Math.min(to, this.end);
    if (!(hi > lo)) return out;
    const { baseMs } = this;
    if (level <= this.topLevel) {
      for (let s = Math.floor(lo / width) * width; s < hi; s += width) {
        const n = this.node(level, s);
        out.push({
          bucket: s,
          count: width / baseMs,
          firstT: s,
          first: toValue(n.first),
          minT: n.minT,
          min: toValue(n.min),
          maxT: n.maxT,
          max: toValue(n.max),
          lastT: s + width - baseMs,
          last: toValue(n.last),
        });
      }
      return out;
    }
    const W = this.topWidth;
    for (let b = Math.floor(lo / width) * width; b < hi; b += width) {
      const s0 = Math.max(b, this.start);
      const s1 = Math.min(b + width, this.end);
      let value: BucketValue | undefined;
      for (let s = s0; s < s1; s += W) {
        const n = this.#top[(s - this.start) / W];
        if (!value)
          value = {
            bucket: b,
            count: 0,
            firstT: s,
            first: n.first,
            minT: n.minT,
            min: n.min,
            maxT: n.maxT,
            max: n.max,
            lastT: 0,
            last: 0,
          };
        value.count += W / baseMs;
        if (n.min < value.min) {
          value.min = n.min;
          value.minT = n.minT;
        }
        if (n.max > value.max) {
          value.max = n.max;
          value.maxT = n.maxT;
        }
        value.lastT = s + W - baseMs;
        value.last = n.last;
      }
      if (value) {
        value.first = toValue(value.first);
        value.min = toValue(value.min);
        value.max = toValue(value.max);
        value.last = toValue(value.last);
        out.push(value);
      }
    }
    return out;
  }

  /** The value of every point in `[from, to)` (level 0 nodes), for tests. */
  points(from: number, to: number, toValue: (x: number) => number) {
    const times: number[] = [];
    const values: number[] = [];
    const lo = Math.max(
      this.start,
      Math.ceil(from / this.baseMs) * this.baseMs,
    );
    for (let t = lo; t < Math.min(to, this.end); t += this.baseMs) {
      times.push(t);
      values.push(toValue(this.node(0, t).first));
    }
    return { times, values };
  }
}
