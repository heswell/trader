/**
 * Trading limits: the metrics a limit can be set on, how a value set on an
 * entity applies to the entities below it, and the entity tree limits attach
 * to (Firm -> desk -> account).
 *
 * The string values are stored in Vuu `string` columns, so they must never be
 * renamed without a migration. The column names follow
 * `@heswell/vuu-module-limits` (`limitDefinitions`), so the two can merge.
 */

type ValueOf<T> = T[keyof T];

const values = <T extends Record<string, string>>(e: T) =>
  Object.freeze(Object.values(e)) as readonly ValueOf<T>[];

export const LimitMetric = Object.freeze({
  /** Quantity of one order. */
  OrderQty: "ORDER_QTY",
  /** USD notional of one order (an option's premium). */
  OrderNotional: "ORDER_NOTIONAL",
  /** Orders created per second, over a rolling second. */
  OrderRate: "ORDER_RATE",
  /** USD notional of the position in one RIC, worst case with working orders. */
  PositionNotional: "POSITION_NOTIONAL",
  /** Sum of the absolute USD notional of every position. */
  GrossPositionNotional: "GROSS_POSITION_NOTIONAL",
  /** Net USD delta on one underlying: the stock, its futures and options. */
  NetDelta: "NET_DELTA",
  /** Loss today, in USD: minus the total P&L of every position. */
  DailyLoss: "DAILY_LOSS",
} as const);
export type LimitMetric = ValueOf<typeof LimitMetric>;
export const LIMIT_METRICS = values(LimitMetric);

/** What one limit value is measured over. */
export const LimitScope = Object.freeze({
  PerOrder: "PER_ORDER",
  /** Everything the entity holds or does. */
  All: "ALL",
  /** Each RIC on its own; with `ric` set, that RIC only (a carve-out). */
  PerRic: "PER_RIC",
  /** Each underlying on its own; with `ric` set, that underlying only. */
  Underlying: "UNDERLYING",
} as const);
export type LimitScope = ValueOf<typeof LimitScope>;
export const LIMIT_SCOPES = values(LimitScope);

export const LimitPeriod = Object.freeze({
  /** A per-order limit has no period. */
  None: "NONE",
  Intraday: "INTRADAY",
  Overnight: "OVERNIGHT",
  Day: "DAY",
  RollingSecond: "ROLLING_1S",
} as const);
export type LimitPeriod = ValueOf<typeof LimitPeriod>;
export const LIMIT_PERIODS = values(LimitPeriod);

/**
 * How a value set on an entity applies to the entities below it.
 * - override: the nearest value up the tree applies, higher or lower.
 * - cap: an entity can only go lower than its parent; its own value must not
 *   be above its parent's effective value.
 */
export const LimitRule = Object.freeze({
  Override: "override",
  Cap: "cap",
} as const);
export type LimitRule = ValueOf<typeof LimitRule>;

export interface LimitMetricInfo {
  metric: LimitMetric;
  label: string;
  scope: LimitScope;
  period: LimitPeriod;
  rule: LimitRule;
  /** Unit of warning, soft and hard: USD, a quantity, or orders per second. */
  unit: "USD" | "qty" | "/s";
}

const info = (
  metric: LimitMetric,
  label: string,
  scope: LimitScope,
  period: LimitPeriod,
  rule: LimitRule,
  unit: LimitMetricInfo["unit"],
): LimitMetricInfo => ({ metric, label, scope, period, rule, unit });

/** Each metric's default scope and period, its rule and unit. */
export const LIMIT_METRIC_INFO: Readonly<Record<LimitMetric, LimitMetricInfo>> =
  Object.freeze({
    [LimitMetric.OrderQty]: info(
      LimitMetric.OrderQty,
      "Order quantity",
      LimitScope.PerOrder,
      LimitPeriod.None,
      LimitRule.Override,
      "qty",
    ),
    [LimitMetric.OrderNotional]: info(
      LimitMetric.OrderNotional,
      "Order notional",
      LimitScope.PerOrder,
      LimitPeriod.None,
      LimitRule.Override,
      "USD",
    ),
    [LimitMetric.OrderRate]: info(
      LimitMetric.OrderRate,
      "Order rate",
      LimitScope.All,
      LimitPeriod.RollingSecond,
      LimitRule.Override,
      "/s",
    ),
    [LimitMetric.PositionNotional]: info(
      LimitMetric.PositionNotional,
      "Position notional",
      LimitScope.PerRic,
      LimitPeriod.Intraday,
      LimitRule.Override,
      "USD",
    ),
    [LimitMetric.GrossPositionNotional]: info(
      LimitMetric.GrossPositionNotional,
      "Gross position notional",
      LimitScope.All,
      LimitPeriod.Intraday,
      LimitRule.Cap,
      "USD",
    ),
    [LimitMetric.NetDelta]: info(
      LimitMetric.NetDelta,
      "Net delta",
      LimitScope.Underlying,
      LimitPeriod.Intraday,
      LimitRule.Cap,
      "USD",
    ),
    [LimitMetric.DailyLoss]: info(
      LimitMetric.DailyLoss,
      "Daily loss",
      LimitScope.All,
      LimitPeriod.Day,
      LimitRule.Cap,
      "USD",
    ),
  });

export const LimitEntityType = Object.freeze({
  Firm: "FIRM",
  Desk: "DESK",
  Account: "ACCOUNT",
} as const);
export type LimitEntityType = ValueOf<typeof LimitEntityType>;

/** An entity limits attach to. */
export interface LimitEntity {
  entityId: string;
  entityType: LimitEntityType;
  name: string;
  /** The entity above this one, "" for the Firm. */
  parentId: string;
}

/** The id of the root entity. */
export const FIRM_ENTITY_ID = "FIRM";

/**
 * One limit. A breach is measured against `soft` (the limit); `warning` is
 * where utilisation turns amber and `hard` where nothing can override it.
 */
export interface LimitDefinition {
  limitKey: string;
  entityId: string;
  metric: LimitMetric;
  scope: LimitScope;
  /** PER_RIC / UNDERLYING: a single RIC or underlying, "" for each one. */
  ric: string;
  period: LimitPeriod;
  warning: number;
  soft: number;
  hard: number;
  currency: string;
  /** Epoch ms, 0 = no bound. */
  effectiveFrom: number;
  effectiveTo: number;
  owner: string;
  active: boolean;
}

export const LimitState = Object.freeze({
  Ok: "OK",
  Warning: "WARNING",
  SoftBreach: "SOFT_BREACH",
  HardBreach: "HARD_BREACH",
} as const);
export type LimitState = ValueOf<typeof LimitState>;

/** The state of `used` against a limit's thresholds. */
export const limitState = (
  used: number,
  limit: Pick<LimitDefinition, "warning" | "soft" | "hard">,
): LimitState => {
  if (used >= limit.hard && used > limit.soft) return LimitState.HardBreach;
  if (used > limit.soft) return LimitState.SoftBreach;
  if (used >= limit.warning) return LimitState.Warning;
  return LimitState.Ok;
};
