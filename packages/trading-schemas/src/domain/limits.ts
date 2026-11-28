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

/** Where a breach is in its life (limitBreaches.status). */
export const BreachStatus = Object.freeze({
  /** Not acknowledged yet. */
  Open: "OPEN",
  /** Acknowledged; still over the level it opened at. */
  Acknowledged: "ACKNOWLEDGED",
  /** Acknowledged and back under the level it opened at. */
  Closed: "CLOSED",
} as const);
export type BreachStatus = ValueOf<typeof BreachStatus>;
export const BREACH_STATUSES = values(BreachStatus);

/** What happened to a breach (limitBreachEvents.kind). */
export const BreachEventKind = Object.freeze({
  /** Crossed a level: warning, the limit or the hard limit. */
  Crossed: "CROSSED",
  Acknowledged: "ACKNOWLEDGED",
  Escalated: "ESCALATED",
  Comment: "COMMENT",
  KillSwitch: "KILL_SWITCH",
  IncreaseRequested: "INCREASE_REQUESTED",
  IncreaseApproved: "INCREASE_APPROVED",
  IncreaseRejected: "INCREASE_REJECTED",
  Closed: "CLOSED",
} as const);
export type BreachEventKind = ValueOf<typeof BreachEventKind>;

/** A request for a temporary limit increase (limitRequests.status). */
export const LimitRequestStatus = Object.freeze({
  Pending: "PENDING",
  /** Approved and in force until expiresAt. */
  Approved: "APPROVED",
  Rejected: "REJECTED",
  Withdrawn: "WITHDRAWN",
  /** Approved, and past expiresAt: the limit is back to its own value. */
  Expired: "EXPIRED",
} as const);
export type LimitRequestStatus = ValueOf<typeof LimitRequestStatus>;
export const LIMIT_REQUEST_STATUSES = values(LimitRequestStatus);

/** The user name the OMS acts as (an automatic kill switch, escalation). */
export const LIMITS_SYSTEM_USER = "system";

/** An unacknowledged breach escalates after this long (ms). */
export const BREACH_ESCALATE_MS = 5 * 60_000;

/** The state ranks, lowest first, for comparing two states. */
export const LIMIT_STATE_RANK: Readonly<Record<LimitState, number>> =
  Object.freeze({
    [LimitState.Ok]: 0,
    [LimitState.Warning]: 1,
    [LimitState.SoftBreach]: 2,
    [LimitState.HardBreach]: 3,
  });

/** Why a trader sends an order over a limit (soft breach) anyway. */
export const LimitOverrideReason = Object.freeze({
  ClientFacilitation: "CLIENT_FACILITATION",
  Hedging: "HEDGING",
  ReducingTomorrow: "REDUCING_TOMORROW",
  /** Needs a note. */
  Other: "OTHER",
} as const);
export type LimitOverrideReason = ValueOf<typeof LimitOverrideReason>;
export const LIMIT_OVERRIDE_REASONS = values(LimitOverrideReason);

export const LIMIT_OVERRIDE_REASON_LABEL: Readonly<
  Record<LimitOverrideReason, string>
> = Object.freeze({
  [LimitOverrideReason.ClientFacilitation]: "Client facilitation",
  [LimitOverrideReason.Hedging]: "Hedging another position",
  [LimitOverrideReason.ReducingTomorrow]: "Reducing tomorrow",
  [LimitOverrideReason.Other]: "Other",
});

/**
 * One limit as an order would leave it: the pre-trade limit check the
 * ticket shows (checkLimits, and the orderEntry limitCheck column). Values
 * are in the metric's unit; utilisation is against `soft` (the limit).
 */
export interface LimitCheckLine {
  limitKey: string;
  /** The entity the limit applies to: the account, its desk or the Firm. */
  entityId: string;
  metric: LimitMetric;
  /** PER_RIC / UNDERLYING: the RIC or underlying measured. */
  ric: string;
  /** Usage now and after the order. */
  before: number;
  after: number;
  warning: number;
  soft: number;
  hard: number;
  /** The state after the order. */
  state: LimitState;
  /**
   * The order breaks this limit: it adds to the usage and leaves it over
   * the limit (soft) or at the hard limit. An order that reduces a position
   * breaks nothing, whatever the state.
   */
  breach: boolean;
  /**
   * The largest quantity this order could have and stay under the hard
   * limit; absent when this limit sets no bound on it.
   */
  maxQty?: number;
}

/**
 * The state of a check: the worst breach, else WARNING when any limit is at
 * warning or over (an order that reduces never breaches), else OK.
 */
export const limitCheckState = (lines: readonly LimitCheckLine[]) => {
  let worst: LimitState = LimitState.Ok;
  for (const line of lines) {
    const state = line.breach
      ? line.state
      : LIMIT_STATE_RANK[line.state] >= LIMIT_STATE_RANK[LimitState.Warning]
        ? LimitState.Warning
        : LimitState.Ok;
    if (LIMIT_STATE_RANK[state] > LIMIT_STATE_RANK[worst]) worst = state;
  }
  return worst;
};

/** The orderEntry limitCheck value for a check ('' when there is none). */
export const encodeLimitCheck = (lines: readonly LimitCheckLine[]) =>
  lines.length === 0 ? "" : JSON.stringify(lines);

/** The lines of a limitCheck value; [] for '' or a value that isn't one. */
export const decodeLimitCheck = (
  value: string | null | undefined,
): LimitCheckLine[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (l): l is LimitCheckLine =>
            !!l &&
            typeof l.limitKey === "string" &&
            typeof l.after === "number" &&
            typeof l.soft === "number" &&
            typeof l.state === "string",
        )
      : [];
  } catch {
    return [];
  }
};
