/** Millisecond time source, injectable so tests are deterministic. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** Manually advanced clock for tests and benchmarks. */
export class ManualClock {
  constructor(public time = 1_700_000_000_000) {}

  readonly now: Clock = () => this.time;

  advance(ms: number) {
    this.time += ms;
    return this.time;
  }
}
