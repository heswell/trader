import {
  BREACH_ESCALATE_MS,
  BreachEventKind,
  BreachStatus,
  LIMIT_STATE_RANK,
  LimitEntityType,
  LimitMetric,
  LimitRequestStatus,
  LimitState,
  LIMITS_SYSTEM_USER,
  RejectReason,
} from "@heswell/trading-schemas";
import type { AccessScope } from "../permissions/access";
import type { LimitBook } from "./LimitBook";
import type { LimitUtilisationRow } from "./utilisation";

/** A row of the limitBreaches table. */
export interface LimitBreach {
  breachId: string;
  limitKey: string;
  entityId: string;
  entityType: string;
  parentId: string;
  metric: string;
  ric: string;
  worst: string;
  /** The highest state reached. */
  severity: LimitState;
  /** The state now. */
  state: LimitState;
  status: BreachStatus;
  openedAt: number;
  atBreach: number;
  peak: number;
  peakAt: number;
  used: number;
  warning: number;
  soft: number;
  hard: number;
  utilisation: number;
  peakUtilisation: number;
  owner: string;
  acknowledgedBy: string;
  acknowledgedAt: number;
  escalatedTo: string;
  escalatedAt: number;
  closedAt: number;
  lastUpdate: number;
}

/** A row of the limitRequests table. */
export interface LimitRequest {
  requestId: string;
  limitKey: string;
  entityId: string;
  metric: string;
  ric: string;
  breachId: string;
  currentSoft: number;
  currentHard: number;
  soft: number;
  hard: number;
  expiresAt: number;
  reason: string;
  detail: string;
  requestedBy: string;
  requestedAt: number;
  approver: string;
  status: LimitRequestStatus;
  decidedBy: string;
  decidedAt: number;
  comment: string;
}

/** A row of the killSwitches table. */
export interface KillSwitch {
  entityId: string;
  entityType: string;
  active: boolean;
  reason: string;
  activatedBy: string;
  activatedAt: number;
  cancelled: number;
  breachId: string;
  releasedBy: string;
  releasedAt: number;
}

/** Where the monitor writes its rows (TableSink). */
export interface LimitMonitorSink {
  limitBreach?(row: LimitBreach): void;
  limitBreachEvent?(row: object): void;
  limitRequest?(row: LimitRequest): void;
  killSwitch?(row: KillSwitch): void;
  limit?(row: object): void;
}

/** Who is acting, and what they may see. access undefined = unrestricted. */
export interface LimitActor {
  user: string;
  access?: AccessScope;
}

export type LimitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RejectReason; text: string };

const fail = <T>(reason: RejectReason, text: string): LimitResult<T> => ({
  ok: false,
  reason,
  text,
});

export interface LimitMonitorOptions {
  book: LimitBook;
  sink: LimitMonitorSink;
  clock: () => number;
  /** Who breaches escalate to, and the default approver of an increase. */
  escalateTo: string;
  /** Cancel the working orders of these accounts; returns the orderIds. */
  cancelWorking: (accounts: readonly string[], user: string) => string[];
}

const LEVEL_TEXT: Record<LimitState, string> = {
  [LimitState.Ok]: "Back under warning",
  [LimitState.Warning]: "Crossed warning",
  [LimitState.SoftBreach]: "Crossed limit",
  [LimitState.HardBreach]: "Crossed hard limit",
};

const fmt = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${+n.toFixed(2)}`;
};

/**
 * May supervise: approve increases, release a kill switch, stop a desk or
 * the firm. A trading-supervisor, or the unrestricted dev user (auto mode,
 * no roles, owns no accounts).
 */
export const canSupervise = (access: AccessScope | undefined) =>
  !access ||
  access.basis === "supervisor" ||
  (access.basis === "dev" && access.all);

/**
 * Breaches, temporary increases and kill switches, over a LimitBook.
 *
 * - A breach opens when a limit's usage reaches its warning level, and
 *   closes once acknowledged and back under the level it opened at. A
 *   breach not acknowledged within BREACH_ESCALATE_MS escalates.
 * - A temporary increase is requested by anyone who can see the limit and
 *   approved by a supervisor other than the requester; it reverts at its
 *   expiry.
 * - A kill switch on an entity stops trading below it (see LimitBook.killed);
 *   daily loss reaching its hard level turns one on for that entity.
 */
export class LimitMonitor {
  readonly breaches = new Map<string, LimitBreach>();
  readonly requests = new Map<string, LimitRequest>();
  readonly killSwitches = new Map<string, KillSwitch>();
  /** The breach not yet closed of each limit. */
  #openByLimit = new Map<string, LimitBreach>();
  /** The state each open breach opened at. */
  #openedAt = new Map<string, LimitState>();
  #eventSeq = new Map<string, number>();
  #breachSeq = 0;
  #requestSeq = 0;
  readonly #o: LimitMonitorOptions;

  constructor(options: LimitMonitorOptions) {
    this.#o = options;
  }

  get #book() {
    return this.#o.book;
  }

  #now() {
    return this.#o.clock();
  }

  #canSee(entityId: string, actor: LimitActor) {
    const { access } = actor;
    if (!access || access.all) return true;
    // an entity is visible when an account the user sees is at or below it
    return this.#book
      .accountsUnder(entityId)
      .some((account) => access.accounts.has(account));
  }

  // ------------------------------------------------------------ breaches

  /**
   * Follow usage: open, raise, close and escalate breaches, expire
   * temporary increases, and trip the kill switch on daily loss at hard.
   */
  update(rows: readonly LimitUtilisationRow[], now = this.#now()) {
    this.#expireRequests(now);
    for (const row of rows) this.#follow(row, now);
    for (const breach of this.#openByLimit.values()) {
      if (
        breach.status === BreachStatus.Open &&
        !breach.escalatedTo &&
        now - breach.openedAt >= BREACH_ESCALATE_MS
      ) {
        this.#escalate(
          breach,
          LIMITS_SYSTEM_USER,
          `Automatic: not acknowledged within ${BREACH_ESCALATE_MS / 60_000} minutes`,
          now,
        );
      }
    }
  }

  #follow(row: LimitUtilisationRow, now: number) {
    const state = row.state as LimitState;
    const rank = LIMIT_STATE_RANK[state];
    let breach = this.#openByLimit.get(row.limitKey);
    if (!breach) {
      if (rank === 0) return;
      breach = this.#open(row, now);
    }
    const before = breach.severity;
    breach.used = row.used;
    breach.state = state;
    breach.utilisation = row.utilisation;
    breach.warning = row.warning;
    breach.soft = row.soft;
    breach.hard = row.hard;
    if (row.used > breach.peak) {
      breach.peak = row.used;
      breach.peakAt = now;
      breach.peakUtilisation = row.utilisation;
      if (row.worst) breach.worst = row.worst;
    }
    if (rank > LIMIT_STATE_RANK[before]) {
      breach.severity = state;
      this.#event(breach, BreachEventKind.Crossed, now, {
        value: row.used,
        text: `${LEVEL_TEXT[state]} ${fmt(row.used)}`,
      });
    }
    breach.lastUpdate = now;
    this.#closeIfDone(breach, now);
    this.#o.sink.limitBreach?.({ ...breach });

    if (
      row.metric === LimitMetric.DailyLoss &&
      state === LimitState.HardBreach &&
      !this.#book.killed.has(row.entityId)
    ) {
      this.#kill(
        row.entityId,
        `Daily loss hard breach (${fmt(row.used)} of ${fmt(row.soft)})`,
        true,
        LIMITS_SYSTEM_USER,
        breach.breachId,
        now,
      );
    }
  }

  #open(row: LimitUtilisationRow, now: number): LimitBreach {
    const state = row.state as LimitState;
    const limit = this.#book.limits.get(row.limitKey);
    const breach: LimitBreach = {
      breachId: `B-${++this.#breachSeq}`,
      limitKey: row.limitKey,
      entityId: row.entityId,
      entityType: row.entityType,
      parentId: row.parentId,
      metric: row.metric,
      ric: row.ric,
      worst: row.worst,
      severity: state,
      state,
      status: BreachStatus.Open,
      openedAt: now,
      atBreach: row.used,
      peak: row.used,
      peakAt: now,
      used: row.used,
      warning: row.warning,
      soft: row.soft,
      hard: row.hard,
      utilisation: row.utilisation,
      peakUtilisation: row.utilisation,
      owner: limit?.owner ?? "",
      acknowledgedBy: "",
      acknowledgedAt: 0,
      escalatedTo: "",
      escalatedAt: 0,
      closedAt: 0,
      lastUpdate: now,
    };
    this.breaches.set(breach.breachId, breach);
    this.#openByLimit.set(row.limitKey, breach);
    this.#openedAt.set(breach.breachId, state);
    this.#event(breach, BreachEventKind.Crossed, now, {
      value: row.used,
      text: `${LEVEL_TEXT[state]} ${fmt(row.used)}`,
    });
    return breach;
  }

  #closeIfDone(breach: LimitBreach, now: number) {
    const opened = this.#openedAt.get(breach.breachId) ?? LimitState.Warning;
    if (
      breach.status === BreachStatus.Acknowledged &&
      LIMIT_STATE_RANK[breach.state] < LIMIT_STATE_RANK[opened]
    ) {
      breach.status = BreachStatus.Closed;
      breach.closedAt = now;
      this.#openByLimit.delete(breach.limitKey);
      this.#openedAt.delete(breach.breachId);
      this.#event(breach, BreachEventKind.Closed, now, {
        value: breach.used,
        text: `Closed at ${fmt(breach.used)}`,
      });
    }
  }

  #event(
    breach: LimitBreach,
    kind: BreachEventKind,
    time: number,
    { user = LIMITS_SYSTEM_USER, value = 0, text = "" } = {},
  ) {
    const n = (this.#eventSeq.get(breach.breachId) ?? 0) + 1;
    this.#eventSeq.set(breach.breachId, n);
    this.#o.sink.limitBreachEvent?.({
      eventId: `${breach.breachId}-${n}`,
      breachId: breach.breachId,
      entityId: breach.entityId,
      time,
      kind,
      user,
      value,
      text,
    });
  }

  #breachFor(breachId: string, actor: LimitActor) {
    const breach = this.breaches.get(breachId);
    if (!breach || !this.#canSee(breach.entityId, actor)) {
      return fail<LimitBreach>(
        RejectReason.InvalidRequest,
        `no breach ${breachId}`,
      );
    }
    return { ok: true as const, value: breach };
  }

  acknowledge(breachId: string, actor: LimitActor, comment = "") {
    const found = this.#breachFor(breachId, actor);
    if (!found.ok) return found;
    const breach = found.value;
    if (breach.status !== BreachStatus.Open) {
      return fail<LimitBreach>(
        RejectReason.InvalidRequest,
        `${breachId} is already ${breach.status.toLowerCase()}`,
      );
    }
    const now = this.#now();
    breach.status = BreachStatus.Acknowledged;
    breach.acknowledgedBy = actor.user;
    breach.acknowledgedAt = now;
    breach.lastUpdate = now;
    this.#event(breach, BreachEventKind.Acknowledged, now, {
      user: actor.user,
      text: comment,
    });
    this.#closeIfDone(breach, now);
    this.#o.sink.limitBreach?.({ ...breach });
    return { ok: true as const, value: breach };
  }

  escalate(breachId: string, actor: LimitActor, comment = "") {
    const found = this.#breachFor(breachId, actor);
    if (!found.ok) return found;
    const breach = found.value;
    if (breach.status === BreachStatus.Closed) {
      return fail<LimitBreach>(
        RejectReason.InvalidRequest,
        `${breachId} is closed`,
      );
    }
    this.#escalate(breach, actor.user, comment, this.#now());
    return { ok: true as const, value: breach };
  }

  #escalate(breach: LimitBreach, user: string, text: string, now: number) {
    breach.escalatedTo = this.#o.escalateTo;
    breach.escalatedAt = now;
    breach.lastUpdate = now;
    this.#event(breach, BreachEventKind.Escalated, now, {
      user,
      text: text
        ? `Escalated to ${this.#o.escalateTo}: ${text}`
        : `Escalated to ${this.#o.escalateTo}`,
    });
    this.#o.sink.limitBreach?.({ ...breach });
  }

  comment(breachId: string, actor: LimitActor, comment: string) {
    const found = this.#breachFor(breachId, actor);
    if (!found.ok) return found;
    this.#event(found.value, BreachEventKind.Comment, this.#now(), {
      user: actor.user,
      text: comment,
    });
    return found;
  }

  // ------------------------------------------------------------ increases

  /** Ask for a temporary increase of a limit (see requestLimitIncreaseParams). */
  requestIncrease(
    p: {
      limitKey: string;
      soft: number;
      hard?: number;
      expiresAt: number;
      reason: string;
      detail?: string;
      breachId?: string;
      approver?: string;
    },
    actor: LimitActor,
  ): LimitResult<LimitRequest> {
    const limit = this.#book.limits.get(p.limitKey);
    if (!limit || !this.#canSee(limit.entityId, actor)) {
      return fail(RejectReason.InvalidRequest, `no limit ${p.limitKey}`);
    }
    const now = this.#now();
    const current = this.#book.inForce(p.limitKey) ?? limit;
    if (!(p.soft > current.soft)) {
      return fail(
        RejectReason.InvalidRequest,
        `the new limit ${fmt(p.soft)} must be above ${fmt(current.soft)}`,
      );
    }
    if (!(p.expiresAt > now)) {
      return fail(RejectReason.InvalidRequest, "expiresAt must be in future");
    }
    // keep the limit's hard margin unless one is given
    const hard =
      p.hard ?? (limit.soft > 0 ? (p.soft * limit.hard) / limit.soft : p.soft);
    if (hard < p.soft) {
      return fail(
        RejectReason.InvalidRequest,
        "the hard limit must not be below the limit",
      );
    }
    const breach = p.breachId ? this.breaches.get(p.breachId) : undefined;
    const request: LimitRequest = {
      requestId: `R-${++this.#requestSeq}`,
      limitKey: p.limitKey,
      entityId: limit.entityId,
      metric: limit.metric,
      ric: limit.ric,
      breachId: breach?.breachId ?? "",
      currentSoft: current.soft,
      currentHard: current.hard,
      soft: p.soft,
      hard,
      expiresAt: p.expiresAt,
      reason: p.reason,
      detail: p.detail ?? "",
      requestedBy: actor.user,
      requestedAt: now,
      approver: p.approver ?? this.#o.escalateTo,
      status: LimitRequestStatus.Pending,
      decidedBy: "",
      decidedAt: 0,
      comment: "",
    };
    this.requests.set(request.requestId, request);
    this.#o.sink.limitRequest?.({ ...request });
    if (breach) {
      this.#event(breach, BreachEventKind.IncreaseRequested, now, {
        user: actor.user,
        value: p.soft,
        text: `${request.requestId}: ${fmt(current.soft)} to ${fmt(p.soft)}, ${p.reason}`,
      });
    }
    return { ok: true, value: request };
  }

  #pending(requestId: string, actor: LimitActor) {
    const request = this.requests.get(requestId);
    if (!request || !this.#canSee(request.entityId, actor)) {
      return fail<LimitRequest>(
        RejectReason.InvalidRequest,
        `no request ${requestId}`,
      );
    }
    if (request.status !== LimitRequestStatus.Pending) {
      return fail<LimitRequest>(
        RejectReason.InvalidRequest,
        `${requestId} is ${request.status.toLowerCase()}`,
      );
    }
    return { ok: true as const, value: request };
  }

  #decide(
    request: LimitRequest,
    status: LimitRequestStatus,
    user: string,
    comment: string,
  ) {
    const now = this.#now();
    request.status = status;
    request.decidedBy = user;
    request.decidedAt = now;
    request.comment = comment;
    this.#o.sink.limitRequest?.({ ...request });
    const breach = request.breachId
      ? this.breaches.get(request.breachId)
      : undefined;
    if (breach && status !== LimitRequestStatus.Withdrawn) {
      this.#event(
        breach,
        status === LimitRequestStatus.Approved
          ? BreachEventKind.IncreaseApproved
          : BreachEventKind.IncreaseRejected,
        now,
        {
          user,
          value: request.soft,
          text: `${request.requestId} ${status.toLowerCase()}${comment ? `: ${comment}` : ""}`,
        },
      );
    }
  }

  approve(requestId: string, actor: LimitActor, comment = "") {
    const found = this.#pending(requestId, actor);
    if (!found.ok) return found;
    const request = found.value;
    if (!canSupervise(actor.access)) {
      return fail<LimitRequest>(
        RejectReason.PermissionDenied,
        `${actor.user} needs the trading-supervisor role to approve`,
      );
    }
    if (request.requestedBy === actor.user) {
      return fail<LimitRequest>(
        RejectReason.PermissionDenied,
        `${actor.user} may not approve their own request`,
      );
    }
    if (!(request.expiresAt > this.#now())) {
      this.#decide(request, LimitRequestStatus.Expired, actor.user, comment);
      return fail<LimitRequest>(
        RejectReason.InvalidRequest,
        `${requestId} expired before it was approved`,
      );
    }
    // one temporary increase per limit: an earlier one ends now
    for (const other of this.requests.values()) {
      if (
        other.limitKey === request.limitKey &&
        other.status === LimitRequestStatus.Approved
      ) {
        other.status = LimitRequestStatus.Expired;
        this.#o.sink.limitRequest?.({ ...other });
      }
    }
    this.#book.setTemporary(
      request.limitKey,
      request.soft,
      request.hard,
      request.expiresAt,
    );
    this.#publishLimit(request.limitKey);
    this.#decide(request, LimitRequestStatus.Approved, actor.user, comment);
    return { ok: true as const, value: request };
  }

  reject(requestId: string, actor: LimitActor, comment = "") {
    const found = this.#pending(requestId, actor);
    if (!found.ok) return found;
    if (!canSupervise(actor.access)) {
      return fail<LimitRequest>(
        RejectReason.PermissionDenied,
        `${actor.user} needs the trading-supervisor role to reject`,
      );
    }
    this.#decide(found.value, LimitRequestStatus.Rejected, actor.user, comment);
    return found;
  }

  withdraw(requestId: string, actor: LimitActor) {
    const found = this.#pending(requestId, actor);
    if (!found.ok) return found;
    if (found.value.requestedBy !== actor.user) {
      return fail<LimitRequest>(
        RejectReason.PermissionDenied,
        `only ${found.value.requestedBy} can withdraw ${requestId}`,
      );
    }
    this.#decide(found.value, LimitRequestStatus.Withdrawn, actor.user, "");
    return found;
  }

  #expireRequests(now: number) {
    for (const request of this.requests.values()) {
      if (
        request.status === LimitRequestStatus.Approved &&
        request.expiresAt <= now
      ) {
        request.status = LimitRequestStatus.Expired;
        this.#o.sink.limitRequest?.({ ...request });
        this.#book.clearTemporary(request.limitKey);
        this.#publishLimit(request.limitKey);
      }
    }
  }

  /** The limits row of a limit as in force now. */
  limitRow(limitKey: string) {
    const limit = this.#book.inForce(limitKey);
    if (!limit) return undefined;
    const temporary = this.#book.temporary.get(limitKey) === limit;
    return {
      ...limit,
      // a temporary increase keeps the limit's own dates
      effectiveTo: temporary
        ? (this.#book.limits.get(limitKey)?.effectiveTo ?? 0)
        : limit.effectiveTo,
      entityType: this.#book.entities.get(limit.entityId)?.entityType ?? "",
      temporaryUntil: temporary ? limit.effectiveTo : 0,
    };
  }

  #publishLimit(limitKey: string) {
    const row = this.limitRow(limitKey);
    if (row) this.#o.sink.limit?.(row);
  }

  // ------------------------------------------------------------ kill switch

  /**
   * Stop trading for an entity. An account needs trading-execute on it or a
   * supervisor; a desk or the firm needs a supervisor.
   */
  kill(
    p: {
      entityId: string;
      reason: string;
      cancelWorking?: boolean;
      breachId?: string;
    },
    actor: LimitActor,
  ): LimitResult<KillSwitch & { orderIds: string[] }> {
    const entity = this.#book.entities.get(p.entityId);
    if (!entity || !this.#canSee(p.entityId, actor)) {
      return fail(RejectReason.InvalidRequest, `no entity ${p.entityId}`);
    }
    const { access } = actor;
    if (
      entity.entityType === LimitEntityType.Account
        ? !canSupervise(access) && access && !access.canExecute
        : !canSupervise(access)
    ) {
      return fail(
        RejectReason.PermissionDenied,
        entity.entityType === LimitEntityType.Account
          ? `${actor.user} may not trade ${p.entityId}`
          : `${actor.user} needs the trading-supervisor role to stop ${p.entityId}`,
      );
    }
    if (this.#book.killed.has(p.entityId)) {
      return fail(
        RejectReason.InvalidRequest,
        `trading is already stopped for ${p.entityId}`,
      );
    }
    return {
      ok: true,
      value: this.#kill(
        p.entityId,
        p.reason,
        p.cancelWorking ?? false,
        actor.user,
        p.breachId ?? "",
        this.#now(),
      ),
    };
  }

  #kill(
    entityId: string,
    reason: string,
    cancelWorking: boolean,
    user: string,
    breachId: string,
    now: number,
  ) {
    this.#book.kill(entityId, reason);
    const orderIds = cancelWorking
      ? this.#o.cancelWorking(this.#book.accountsUnder(entityId), user)
      : [];
    const row: KillSwitch = {
      entityId,
      entityType: this.#book.entities.get(entityId)?.entityType ?? "",
      active: true,
      reason,
      activatedBy: user,
      activatedAt: now,
      cancelled: orderIds.length,
      breachId,
      releasedBy: "",
      releasedAt: 0,
    };
    this.killSwitches.set(entityId, row);
    this.#o.sink.killSwitch?.({ ...row });
    const breach = breachId ? this.breaches.get(breachId) : undefined;
    if (breach) {
      this.#event(breach, BreachEventKind.KillSwitch, now, {
        user,
        text: `Kill switch on ${entityId}${
          orderIds.length
            ? `; ${orderIds.length} working order${orderIds.length === 1 ? "" : "s"} cancelled`
            : ""
        }`,
      });
    }
    return { ...row, orderIds };
  }

  /** Turn trading back on for an entity (a supervisor). */
  release(entityId: string, actor: LimitActor, comment = "") {
    const row = this.killSwitches.get(entityId);
    if (!row?.active || !this.#canSee(entityId, actor)) {
      return fail<KillSwitch>(
        RejectReason.InvalidRequest,
        `trading is not stopped for ${entityId}`,
      );
    }
    if (!canSupervise(actor.access)) {
      return fail<KillSwitch>(
        RejectReason.PermissionDenied,
        `${actor.user} needs the trading-supervisor role to turn trading back on`,
      );
    }
    const now = this.#now();
    this.#book.release(entityId);
    row.active = false;
    row.releasedBy = actor.user;
    row.releasedAt = now;
    this.#o.sink.killSwitch?.({ ...row });
    const breach = row.breachId ? this.breaches.get(row.breachId) : undefined;
    if (breach) {
      this.#event(breach, BreachEventKind.KillSwitch, now, {
        user: actor.user,
        text: `Trading back on for ${entityId}${comment ? `: ${comment}` : ""}`,
      });
    }
    return { ok: true as const, value: row };
  }
}
