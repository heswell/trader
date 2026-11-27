import {
  type LimitDefinition,
  LimitEntityType,
  LimitMetric,
  LimitScope,
  limitState,
} from "@heswell/trading-schemas";
import type { LimitBook } from "./LimitBook";

/** What usage is measured from: a position of the OMS. */
export interface UsagePosition {
  account: string;
  ric: string;
  underlying: string;
  marketValueUsd: number;
  deltaUsd?: number;
  totalPnlUsd: number;
}

/** The largest order an account created today. */
export interface OrderPeak {
  qty: number;
  notionalUsd: number;
}

export interface UsageSources {
  positions: Iterable<UsagePosition>;
  orderPeak: (account: string) => OrderPeak | undefined;
  /** Orders the entity created in the last second. */
  recentOrders: (entityId: string) => number;
}

/** A row of the limitUtilisation table. */
export interface LimitUtilisationRow {
  limitKey: string;
  entityId: string;
  entityType: string;
  metric: string;
  scope: string;
  ric: string;
  period: string;
  warning: number;
  soft: number;
  hard: number;
  currency: string;
  /** A temporary increase is in force until then; 0 = none. */
  temporaryUntil: number;
  parentId: string;
  /** The desk (FIRM for the Firm), to group by desk then entity. */
  desk: string;
  worst: string;
  used: number;
  headroom: number;
  utilisation: number;
  state: string;
  lastUpdate: number;
}

const isTotal = (metric: LimitDefinition["metric"]) =>
  metric === LimitMetric.GrossPositionNotional ||
  metric === LimitMetric.OrderRate ||
  metric === LimitMetric.DailyLoss;

/**
 * How much of each limit in force is used.
 *
 * - Totals (gross position notional, order rate, daily loss): the entity's
 *   own total, over every account below it.
 * - Per order (order quantity, order notional): the largest order today of
 *   the accounts the limit applies to, those for which it is the nearest.
 * - Per RIC and per underlying (position notional, net delta): the worst RIC
 *   or underlying of the accounts the limit applies to; `worst` names it.
 *
 * Daily loss is minus the total P&L of the positions, which run from the
 * OMS start: there is no daily P&L reset yet.
 */
export const limitUtilisation = (
  book: LimitBook,
  sources: UsageSources,
  now: number,
): LimitUtilisationRow[] => {
  const accounts = [...book.entities.values()]
    .filter((e) => e.entityType === LimitEntityType.Account)
    .map((e) => e.entityId);
  const membersOf = new Map<string, string[]>();
  for (const account of accounts) {
    for (const { entityId } of book.ancestors(account)) {
      const members = membersOf.get(entityId) ?? [];
      members.push(account);
      membersOf.set(entityId, members);
    }
  }
  const positionsByAccount = new Map<string, UsagePosition[]>();
  for (const position of sources.positions) {
    const list = positionsByAccount.get(position.account) ?? [];
    list.push(position);
    positionsByAccount.set(position.account, list);
  }
  const positionsOf = (account: string) =>
    positionsByAccount.get(account) ?? [];

  const rows: LimitUtilisationRow[] = [];
  for (const { limitKey } of book.limits.values()) {
    // a temporary increase in force replaces the limit
    const limit = book.inForce(limitKey);
    if (!limit) continue;
    const entity = book.entities.get(limit.entityId);
    if (!entity || !book.own(limit.entityId, limit.metric).includes(limit)) {
      continue;
    }
    const members = membersOf.get(limit.entityId) ?? [];
    // Accounts for which this limit is the nearest (override and per-RIC).
    const governs = (account: string, ric = "") =>
      book.effective(account, limit.metric, ric)?.limit === limit;
    let used = 0;
    let worst = "";
    const take = (value: number, key: string) => {
      if (value > used) {
        used = value;
        worst = key;
      }
    };

    if (isTotal(limit.metric)) {
      if (limit.metric === LimitMetric.OrderRate) {
        used = sources.recentOrders(limit.entityId);
      } else {
        let gross = 0;
        let pnl = 0;
        for (const account of members) {
          for (const p of positionsOf(account)) {
            gross += Math.abs(p.marketValueUsd);
            pnl += p.totalPnlUsd;
          }
        }
        used =
          limit.metric === LimitMetric.DailyLoss ? Math.max(0, -pnl) : gross;
      }
    } else if (limit.scope === LimitScope.PerOrder) {
      for (const account of members) {
        if (!governs(account)) continue;
        const peak = sources.orderPeak(account);
        if (!peak) continue;
        take(
          limit.metric === LimitMetric.OrderQty ? peak.qty : peak.notionalUsd,
          account,
        );
      }
    } else if (limit.metric === LimitMetric.PositionNotional) {
      for (const account of members) {
        for (const p of positionsOf(account)) {
          if (limit.ric && p.ric !== limit.ric) continue;
          if (!governs(account, p.ric)) continue;
          take(Math.abs(p.marketValueUsd), p.ric);
        }
      }
    } else if (limit.metric === LimitMetric.NetDelta) {
      for (const account of members) {
        const byUnderlying = new Map<string, number>();
        for (const p of positionsOf(account)) {
          const underlying = p.underlying || p.ric;
          byUnderlying.set(
            underlying,
            (byUnderlying.get(underlying) ?? 0) + (p.deltaUsd ?? 0),
          );
        }
        for (const [underlying, delta] of byUnderlying) {
          if (limit.ric && underlying !== limit.ric) continue;
          if (!governs(account, underlying)) continue;
          take(Math.abs(delta), underlying);
        }
      }
    }

    rows.push({
      limitKey: limit.limitKey,
      entityId: limit.entityId,
      entityType: entity.entityType,
      metric: limit.metric,
      scope: limit.scope,
      ric: limit.ric,
      period: limit.period,
      warning: limit.warning,
      soft: limit.soft,
      hard: limit.hard,
      currency: limit.currency,
      temporaryUntil:
        book.temporary.get(limitKey) === limit ? limit.effectiveTo : 0,
      parentId: entity.parentId,
      desk:
        entity.entityType === LimitEntityType.Account
          ? entity.parentId
          : entity.entityId,
      worst,
      used,
      headroom: limit.soft - used,
      utilisation: limit.soft > 0 ? used / limit.soft : 0,
      state: limitState(used, limit),
      lastUpdate: now,
    });
  }
  return rows;
};
