/**
 * Tick and lot utilities shared by the order ticket, price ladder, OMS
 * validation and exchange-sim quoting bots.
 *
 * A tick schedule is either a flat tick size or price bands (as used by most
 * European venues), each band applying from `from` (inclusive) upwards.
 */

export interface TickBand {
  /** Lower price bound (inclusive) from which `tickSize` applies. */
  from: number;
  tickSize: number;
}

export type TickSchedule = number | readonly TickBand[];

const EPSILON = 1e-9;

/** Number of decimal places needed to represent `value` (max 10). */
export const decimalsOf = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  for (let d = 0; d <= 10; d++) {
    if (Math.abs(value - Number(value.toFixed(d))) < EPSILON) return d;
  }
  return 10;
};

const fix = (value: number, tickSize: number) =>
  Number(value.toFixed(decimalsOf(tickSize)));

const bandsOf = (schedule: TickSchedule): readonly TickBand[] =>
  typeof schedule === "number" ? [{ from: 0, tickSize: schedule }] : schedule;

/** Tick size applying at `price` (band whose `from` <= price). */
export const tickSizeAt = (schedule: TickSchedule, price: number): number => {
  const bands = bandsOf(schedule);
  let tick = bands[0]?.tickSize ?? 0;
  for (const band of bands) {
    if (price + EPSILON >= band.from) tick = band.tickSize;
    else break;
  }
  return tick;
};

/** Tick size of the band immediately below `price` (used to step down). */
const tickSizeBelow = (schedule: TickSchedule, price: number): number => {
  const bands = bandsOf(schedule);
  let tick = bands[0]?.tickSize ?? 0;
  for (const band of bands) {
    if (price - EPSILON > band.from) tick = band.tickSize;
    else break;
  }
  return tick;
};

const ratio = (price: number, tickSize: number) => price / tickSize;

/**
 * Whether `price` is a multiple of the tick size that applies at that price.
 */
export const isOnTick = (price: number, schedule: TickSchedule): boolean => {
  const tick = tickSizeAt(schedule, price);
  if (!(tick > 0)) return false;
  const r = ratio(price, tick);
  return Math.abs(r - Math.round(r)) < EPSILON * Math.max(1, Math.abs(r));
};

export type RoundingMode = "nearest" | "up" | "down";

/** Rounds `price` to the tick schedule (`nearest`, `up` or `down`). */
export const roundToTick = (
  price: number,
  schedule: TickSchedule,
  mode: RoundingMode = "nearest",
): number => {
  if (isOnTick(price, schedule)) {
    return fix(price, tickSizeAt(schedule, price));
  }
  const tick = tickSizeAt(schedule, price);
  const r = ratio(price, tick);
  const n =
    mode === "up"
      ? Math.ceil(r)
      : mode === "down"
        ? Math.floor(r)
        : Math.round(r);
  return fix(n * tick, tick);
};

/**
 * Move `price` by `ticks` (positive = up), honouring band boundaries.
 * An off-tick price is first snapped in the direction of travel, which counts
 * as one step.
 */
export const stepTicks = (
  price: number,
  schedule: TickSchedule,
  ticks: number,
): number => {
  let p = price;
  let remaining = Math.trunc(ticks);
  if (remaining !== 0 && !isOnTick(p, schedule)) {
    p = roundToTick(p, schedule, remaining > 0 ? "up" : "down");
    remaining -= Math.sign(remaining);
  }
  while (remaining > 0) {
    const tick = tickSizeAt(schedule, p);
    p = fix(p + tick, tick);
    remaining--;
  }
  while (remaining < 0) {
    const tick = tickSizeBelow(schedule, p);
    p = fix(p - tick, tick);
    remaining++;
  }
  return p;
};

/** Number of ticks between two on-tick prices (b - a). */
export const ticksBetween = (
  a: number,
  b: number,
  schedule: TickSchedule,
): number => {
  if (typeof schedule === "number") {
    return Math.round((b - a) / schedule);
  }
  const dir = b >= a ? 1 : -1;
  let p = a;
  let n = 0;
  while (dir > 0 ? p + EPSILON < b : p - EPSILON > b) {
    p = stepTicks(p, schedule, dir);
    n += dir;
  }
  return n;
};

/** Whether `quantity` is a positive multiple of `lotSize`. */
export const isValidLot = (quantity: number, lotSize: number): boolean =>
  Number.isFinite(quantity) &&
  quantity > 0 &&
  lotSize > 0 &&
  Math.abs(quantity / lotSize - Math.round(quantity / lotSize)) < EPSILON;

/** Rounds `quantity` to a multiple of `lotSize` (`nearest`, `up` or `down`). */
export const roundToLot = (
  quantity: number,
  lotSize: number,
  mode: RoundingMode = "nearest",
): number => {
  const r = quantity / lotSize;
  const n =
    mode === "up"
      ? Math.ceil(r - EPSILON)
      : mode === "down"
        ? Math.floor(r + EPSILON)
        : Math.round(r);
  return n * lotSize;
};

/**
 * Parse the `instruments.tickBands` column: `"0:0.0005;1:0.001;5:0.005"`.
 * Empty / missing returns undefined (use flat `tickSize`).
 */
export const parseTickBands = (
  value: string | undefined | null,
): TickBand[] | undefined => {
  if (!value?.trim()) return undefined;
  const bands = value.split(";").map((part) => {
    const [from, tickSize] = part.split(":").map((s) => Number(s.trim()));
    if (!Number.isFinite(from) || !(tickSize > 0)) {
      throw Error(`invalid tick band '${part}' in '${value}'`);
    }
    return { from, tickSize };
  });
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].from <= bands[i - 1].from) {
      throw Error(`tick bands must be ascending: '${value}'`);
    }
  }
  return bands;
};

/**
 * Tick bands as the `tickBands` column string, `from:tickSize;...` (inverse of
 * parseTickBands).
 */
export const formatTickBands = (bands: readonly TickBand[]): string =>
  bands.map(({ from, tickSize }) => `${from}:${tickSize}`).join(";");

/** Tick schedule for an instrument row (bands take precedence over tickSize). */
export const tickScheduleOf = (instrument: {
  tickSize: number;
  tickBands?: string;
}): TickSchedule => parseTickBands(instrument.tickBands) ?? instrument.tickSize;
