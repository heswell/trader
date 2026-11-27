import {
  FIRM_ENTITY_ID,
  LIMIT_METRIC_INFO,
  type LimitDefinition,
  type LimitEntity,
  LimitEntityType,
  LimitMetric,
  LimitRule,
  LimitScope,
} from "@heswell/trading-schemas";
import type { Account } from "../reference/accounts";

/**
 * The entity tree from the accounts: the Firm, a desk for each account's
 * desk, then the accounts, in the order they are first seen.
 */
export const limitEntities = (accounts: readonly Account[]): LimitEntity[] => {
  const entities: LimitEntity[] = [
    {
      entityId: FIRM_ENTITY_ID,
      entityType: LimitEntityType.Firm,
      name: "Firm",
      parentId: "",
    },
  ];
  const desks = new Set<string>();
  for (const { desk } of accounts) {
    if (desks.has(desk)) continue;
    desks.add(desk);
    entities.push({
      entityId: desk,
      entityType: LimitEntityType.Desk,
      name: desk,
      parentId: FIRM_ENTITY_ID,
    });
  }
  for (const { account, name, desk } of accounts) {
    entities.push({
      entityId: account,
      entityType: LimitEntityType.Account,
      name,
      parentId: desk,
    });
  }
  return entities;
};

/** The key of a limit: entity, metric and RIC (or underlying). */
export const limitKey = (entityId: string, metric: LimitMetric, ric = "") =>
  ric ? `${entityId}:${metric}:${ric}` : `${entityId}:${metric}`;

/** Warning at 80% of the limit; hard at 100% per order, 110% otherwise. */
export const limitDefinition = (
  entityId: string,
  metric: LimitMetric,
  soft: number,
  o: Partial<LimitDefinition> = {},
): LimitDefinition => {
  const { scope, period } = LIMIT_METRIC_INFO[metric];
  const perOrder = scope === LimitScope.PerOrder;
  return {
    limitKey: limitKey(entityId, metric, o.ric),
    entityId,
    metric,
    scope,
    ric: "",
    period,
    warning: soft * 0.8,
    soft,
    hard: perOrder ? soft : soft * 1.1,
    currency: "USD",
    effectiveFrom: 0,
    effectiveTo: 0,
    owner: "",
    active: true,
    ...o,
  };
};

/**
 * Each account's limits from its own fields: maxOrderQty, maxOrderNotional,
 * maxPositionNotional (per RIC) and maxDeltaUsd (per underlying, when set).
 */
export const accountLimits = (account: Account): LimitDefinition[] => {
  const o = { owner: account.owner };
  const limits = [
    limitDefinition(
      account.account,
      LimitMetric.OrderQty,
      account.maxOrderQty,
      o,
    ),
    limitDefinition(
      account.account,
      LimitMetric.OrderNotional,
      account.maxOrderNotional,
      o,
    ),
    limitDefinition(
      account.account,
      LimitMetric.PositionNotional,
      account.maxPositionNotional,
      o,
    ),
  ];
  if (account.maxDeltaUsd > 0) {
    limits.push(
      limitDefinition(
        account.account,
        LimitMetric.NetDelta,
        account.maxDeltaUsd,
        o,
      ),
    );
  }
  return limits;
};

/** The limit that applies, and the entity it is set on. */
export interface EffectiveLimit {
  limit: LimitDefinition;
  /** The entity the limit is set on: the one asked for, or one above it. */
  entityId: string;
}

const isInForce = (limit: LimitDefinition, now: number) =>
  limit.active &&
  (limit.effectiveFrom === 0 || limit.effectiveFrom <= now) &&
  (limit.effectiveTo === 0 || now < limit.effectiveTo);

/**
 * The limits of an entity tree. A limit set on an entity applies to the
 * entities below it that set none for the same metric: the nearest one up
 * the tree applies. Within an entity, a limit for one RIC (or underlying)
 * comes before the entity's limit for each RIC.
 *
 * Cap metrics are also checked at each entity above, against that entity's
 * own usage (see `ancestors`); `capViolations` finds a value set above its
 * parent's.
 */
export class LimitBook {
  readonly entities = new Map<string, LimitEntity>();
  readonly limits = new Map<string, LimitDefinition>();
  /**
   * Approved temporary increases, by limitKey: while in force (before its
   * effectiveTo) one replaces the limit of the same key.
   */
  readonly temporary = new Map<string, LimitDefinition>();
  /** Entities whose kill switch is on: entityId -> reason. */
  readonly killed = new Map<string, string>();
  /** limitKeys by entity and metric. */
  #byEntity = new Map<string, Map<LimitMetric, Set<string>>>();
  #clock: () => number;

  constructor(
    entities: Iterable<LimitEntity>,
    limits: Iterable<LimitDefinition> = [],
    clock: () => number = Date.now,
  ) {
    this.#clock = clock;
    for (const entity of entities) this.addEntity(entity);
    for (const limit of limits) this.set(limit);
  }

  addEntity(entity: LimitEntity) {
    this.entities.set(entity.entityId, entity);
  }

  set(limit: LimitDefinition) {
    const old = this.limits.get(limit.limitKey);
    if (old) this.#index(old).delete(old.limitKey);
    this.limits.set(limit.limitKey, limit);
    this.#index(limit).add(limit.limitKey);
  }

  /**
   * Raise a limit until `until` (epoch ms): the limit of the same key with
   * `soft` and `hard`, warning scaled with soft.
   */
  setTemporary(limitKey: string, soft: number, hard: number, until: number) {
    const base = this.limits.get(limitKey);
    if (!base) return undefined;
    const temporary: LimitDefinition = {
      ...base,
      warning: base.soft > 0 ? (base.warning * soft) / base.soft : soft * 0.8,
      soft,
      hard,
      effectiveTo: until,
    };
    this.temporary.set(limitKey, temporary);
    return temporary;
  }

  clearTemporary(limitKey: string) {
    return this.temporary.delete(limitKey);
  }

  /** The definition of a limit in force now: a temporary increase, else its own. */
  inForce(limitKey: string): LimitDefinition | undefined {
    const temporary = this.temporary.get(limitKey);
    if (temporary && isInForce(temporary, this.#clock())) return temporary;
    return this.limits.get(limitKey);
  }

  kill(entityId: string, reason: string) {
    this.killed.set(entityId, reason);
  }

  release(entityId: string) {
    return this.killed.delete(entityId);
  }

  /** The entity, or the nearest one above it, whose kill switch is on. */
  killedBy(entityId: string): string | undefined {
    if (this.killed.size === 0) return undefined;
    return this.ancestors(entityId).find((e) => this.killed.has(e.entityId))
      ?.entityId;
  }

  /** The accounts at or below an entity. */
  accountsUnder(entityId: string): string[] {
    const accounts: string[] = [];
    for (const entity of this.entities.values()) {
      if (
        entity.entityType === LimitEntityType.Account &&
        this.ancestors(entity.entityId).some((e) => e.entityId === entityId)
      ) {
        accounts.push(entity.entityId);
      }
    }
    return accounts;
  }

  delete(limitKey: string) {
    const old = this.limits.get(limitKey);
    if (!old) return false;
    this.#index(old).delete(limitKey);
    return this.limits.delete(limitKey);
  }

  #index({ entityId, metric }: LimitDefinition) {
    let metrics = this.#byEntity.get(entityId);
    if (!metrics) {
      metrics = new Map();
      this.#byEntity.set(entityId, metrics);
    }
    let keys = metrics.get(metric);
    if (!keys) {
      keys = new Set();
      metrics.set(metric, keys);
    }
    return keys;
  }

  /** The entity, then each one above it, up to the Firm. */
  ancestors(entityId: string): LimitEntity[] {
    const chain: LimitEntity[] = [];
    let entity = this.entities.get(entityId);
    while (entity && chain.length <= this.entities.size) {
      chain.push(entity);
      entity = entity.parentId ? this.entities.get(entity.parentId) : undefined;
    }
    return chain;
  }

  /** Limits set on the entity itself for a metric, in force now. */
  own(entityId: string, metric: LimitMetric): LimitDefinition[] {
    const keys = this.#byEntity.get(entityId)?.get(metric);
    if (!keys) return [];
    const now = this.#clock();
    const own: LimitDefinition[] = [];
    for (const key of keys) {
      const temporary = this.temporary.get(key);
      const limit =
        temporary && isInForce(temporary, now)
          ? temporary
          : this.limits.get(key);
      if (limit && isInForce(limit, now)) own.push(limit);
    }
    return own;
  }

  /**
   * The limit that applies to an entity for a metric and, for PER_RIC and
   * UNDERLYING metrics, a RIC or underlying. undefined = no limit.
   */
  effective(
    entityId: string,
    metric: LimitMetric,
    ric = "",
  ): EffectiveLimit | undefined {
    for (const entity of this.ancestors(entityId)) {
      const own = this.own(entity.entityId, metric);
      if (own.length === 0) continue;
      const limit =
        (ric ? own.find((l) => l.ric === ric) : undefined) ??
        own.find((l) => l.ric === "");
      if (limit) return { limit, entityId: entity.entityId };
    }
    return undefined;
  }

  /**
   * The limit each entity from this one up to the Firm sets for itself, for
   * a metric checked against each entity's own total (gross position
   * notional, order rate, daily loss).
   */
  ownUp(entityId: string, metric: LimitMetric): EffectiveLimit[] {
    const limits: EffectiveLimit[] = [];
    for (const entity of this.ancestors(entityId)) {
      const limit = this.own(entity.entityId, metric).find((l) => l.ric === "");
      if (limit) limits.push({ limit, entityId: entity.entityId });
    }
    return limits;
  }

  /** The soft limit that applies, Infinity when there is none. */
  softLimit(entityId: string, metric: LimitMetric, ric = "") {
    return this.effective(entityId, metric, ric)?.limit.soft ?? Infinity;
  }

  /**
   * Limits on cap metrics set above the effective value of their entity's
   * parent: each with the parent's limit it breaks.
   */
  capViolations(): { limit: LimitDefinition; parent: EffectiveLimit }[] {
    const violations: { limit: LimitDefinition; parent: EffectiveLimit }[] = [];
    for (const limit of this.limits.values()) {
      if (LIMIT_METRIC_INFO[limit.metric].rule !== LimitRule.Cap) continue;
      const parentId = this.entities.get(limit.entityId)?.parentId;
      if (!parentId) continue;
      const parent = this.effective(parentId, limit.metric, limit.ric);
      if (parent && limit.soft > parent.limit.soft) {
        violations.push({ limit, parent });
      }
    }
    return violations;
  }
}

/** The per-order and position limits pre-trade risk checks an order against. */
export interface OrderLimits {
  maxOrderQty: number;
  maxOrderNotional: number;
  maxPositionNotional: number;
  /** Infinity = no delta limit. */
  maxDeltaUsd: number;
}

/** An account's own fields as OrderLimits (no entity tree). */
export const orderLimitsOf = (account: Account): OrderLimits => ({
  maxOrderQty: account.maxOrderQty,
  maxOrderNotional: account.maxOrderNotional,
  maxPositionNotional: account.maxPositionNotional,
  maxDeltaUsd: account.maxDeltaUsd > 0 ? account.maxDeltaUsd : Infinity,
});

/** The limits that apply to an order for `account` in `ric` (`underlying`). */
export const orderLimits = (
  book: LimitBook,
  account: string,
  ric: string,
  underlying: string,
): OrderLimits => ({
  maxOrderQty: book.softLimit(account, LimitMetric.OrderQty),
  maxOrderNotional: book.softLimit(account, LimitMetric.OrderNotional),
  maxPositionNotional: book.softLimit(
    account,
    LimitMetric.PositionNotional,
    ric,
  ),
  maxDeltaUsd: book.softLimit(account, LimitMetric.NetDelta, underlying),
});

/** A LimitBook for the accounts: their entity tree and their own limits. */
export const limitBookFor = (
  accounts: readonly Account[],
  extra: Iterable<LimitDefinition> = [],
  clock?: () => number,
) =>
  new LimitBook(
    limitEntities(accounts),
    [...accounts.flatMap(accountLimits), ...extra],
    clock,
  );

/**
 * Limits from config: comma separated `ENTITY:METRIC=soft`, or
 * `ENTITY:METRIC:RIC=soft` for one RIC or underlying, e.g.
 * `FIRM:DAILY_LOSS=3000000,ACC-EU-02:POSITION_NOTIONAL:BARC.L=3500000`.
 * Warning and hard follow limitDefinition. Throws on a bad entry.
 */
export const parseLimits = (text: string): LimitDefinition[] =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^([^:=\s]+):([A-Z_]+)(?::([^=\s]+))?=([0-9.]+)$/.exec(
        entry,
      );
      const metric = match?.[2] as LimitMetric | undefined;
      if (!match || !metric || !(metric in LIMIT_METRIC_INFO)) {
        throw Error(
          `limits: "${entry}" is not ENTITY:METRIC[:RIC]=value with a metric of ${Object.keys(LIMIT_METRIC_INFO).join(", ")}`,
        );
      }
      const soft = Number(match[4]);
      if (!(soft > 0)) throw Error(`limits: "${entry}" needs a value above 0`);
      return limitDefinition(match[1], metric, soft, { ric: match[3] ?? "" });
    });

/**
 * The entities a user may see limits for: the accounts they can see and
 * every entity above them; all of them when `all`.
 */
export const visibleEntities = (
  book: LimitBook,
  access: { all: boolean; accounts: ReadonlySet<string> },
): Set<string> => {
  if (access.all) return new Set(book.entities.keys());
  const visible = new Set<string>();
  for (const account of access.accounts) {
    for (const { entityId } of book.ancestors(account)) visible.add(entityId);
  }
  return visible;
};
