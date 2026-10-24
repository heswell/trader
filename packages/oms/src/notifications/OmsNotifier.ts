import { OrdStatus } from "@heswell/trading-schemas";
import type { OmsSink, Position } from "../engine/OmsEngine";
import type { Account } from "../reference/accounts";

/**
 * Notification topics published by the trading server. Portal modules claim
 * them with `notificationTopics` (apps/features/trading/src/catalog.ts).
 */
export const OmsNotificationTopic = Object.freeze({
  Orders: "orders",
  Fills: "fills",
  Risk: "risk",
} as const);
export type OmsNotificationTopic =
  (typeof OmsNotificationTopic)[keyof typeof OmsNotificationTopic];

export type OmsNotificationLevel = "INFO" | "WARNING" | "ERROR";
/** `silent`: recorded and badged, never toasted (see the portal policy). */
export type OmsNotificationType = "toast" | "banner" | "silent";

/** A row of the trading server's NOTIFICATIONS `notifications` table. */
export interface OmsNotification {
  id: string;
  type: OmsNotificationType;
  level: OmsNotificationLevel;
  title: string;
  message: string;
  topic: OmsNotificationTopic;
  /** The account owner; rows are filtered per user by account. */
  audience: string;
  account: string;
  ric: string;
  orderId: string;
  /** Epoch ms; the provider deletes the row after this time. */
  expiryTime: number;
}

export interface OmsNotifierOptions {
  accounts: (account: string) => Account | undefined;
  publish: (notification: OmsNotification) => void;
  clock?: () => number;
  /** Order reject lifetime (default 15 minutes). */
  rejectTtlMs?: number;
  /** Position limit warning / breach lifetime (default 30 minutes). */
  riskTtlMs?: number;
  /** Fraction of maxPositionNotional that warns (default 0.8). */
  warnAt?: number;
  /**
   * Re-arm a position's warning once it falls this far below a threshold
   * (fraction of the limit, default 0.05), so a position hovering at the
   * threshold does not repeat it.
   */
  hysteresis?: number;
  /** Rejected orders remembered to avoid repeats (default 5000). */
  maxTrackedRejects?: number;
}

const MINUTE = 60_000;

/** 0 below the warning threshold, 1 warning, 2 breach. */
type RiskState = 0 | 1 | 2;

const fmtUsd = (value: number) =>
  `$${Math.round(value).toLocaleString("en-US")}`;

/**
 * Turns OMS rows into topic-tagged notifications:
 * - a parent order becoming REJECTED → `orders`, ERROR, silent (the trading
 *   features already toast the reject to the user who sent it);
 * - a position's |market value| reaching `warnAt` of the account's
 *   maxPositionNotional → `risk`, WARNING toast, and reaching the limit →
 *   `risk`, ERROR toast.
 * Fills are not published: the background flow fills continuously, so they
 * would flood the store (the features toast the user's own fills).
 * Attach with `engine.observe(notifier)`.
 */
export class OmsNotifier implements OmsSink {
  readonly #options: Required<Omit<OmsNotifierOptions, "accounts" | "publish">>;
  readonly #accounts: OmsNotifierOptions["accounts"];
  readonly #publish: OmsNotifierOptions["publish"];
  readonly #rejected = new Set<string>();
  readonly #risk = new Map<string, RiskState>();
  #seq = 0;

  constructor({ accounts, publish, ...options }: OmsNotifierOptions) {
    this.#accounts = accounts;
    this.#publish = publish;
    this.#options = {
      clock: Date.now,
      rejectTtlMs: 15 * MINUTE,
      riskTtlMs: 30 * MINUTE,
      warnAt: 0.8,
      hysteresis: 0.05,
      maxTrackedRejects: 5_000,
      ...options,
    };
  }

  parentOrder(row: Record<string, unknown>) {
    if (row.status !== OrdStatus.Rejected) return;
    const orderId = String(row.orderId);
    if (this.#rejected.has(orderId)) return;
    this.#rejected.add(orderId);
    if (this.#rejected.size > this.#options.maxTrackedRejects) {
      const oldest = this.#rejected.values().next().value;
      if (oldest !== undefined) this.#rejected.delete(oldest);
    }
    const account = String(row.account ?? "");
    const ric = String(row.ric ?? "");
    const reason = String(row.rejectReason || "REJECTED");
    const text = String(row.text ?? "");
    this.#emit({
      type: "silent",
      level: "ERROR",
      topic: OmsNotificationTopic.Orders,
      title: `Order rejected: ${row.side} ${row.quantity} ${ric}`,
      message: `${orderId} for ${account}: ${text || reason}`,
      account,
      ric,
      orderId,
      ttlMs: this.#options.rejectTtlMs,
    });
  }

  position(row: Position) {
    const account = this.#accounts(row.account);
    if (!account || !(account.maxPositionNotional > 0)) return;
    const { warnAt, hysteresis } = this.#options;
    const ratio = Math.abs(row.marketValueUsd) / account.maxPositionNotional;
    const previous = this.#risk.get(row.id) ?? 0;
    let next: RiskState = ratio >= 1 ? 2 : ratio >= warnAt ? 1 : 0;
    // Only step down once clear of the threshold by the hysteresis margin.
    if (next < previous) {
      const threshold = previous === 2 ? 1 : warnAt;
      if (ratio > threshold - hysteresis) next = previous;
    }
    if (next === previous) return;
    if (next === 0) this.#risk.delete(row.id);
    else this.#risk.set(row.id, next);
    if (next < previous) return;
    const exposure = `${fmtUsd(Math.abs(row.marketValueUsd))} of ${fmtUsd(account.maxPositionNotional)} (${Math.round(ratio * 100)}%)`;
    this.#emit({
      type: "toast",
      level: next === 2 ? "ERROR" : "WARNING",
      topic: OmsNotificationTopic.Risk,
      title:
        next === 2
          ? `Position limit breached: ${row.ric}`
          : `Position near limit: ${row.ric}`,
      message: `${account.account} ${row.ric} position ${exposure}`,
      account: account.account,
      ric: row.ric,
      orderId: "",
      ttlMs: this.#options.riskTtlMs,
    });
  }

  #emit({
    ttlMs,
    ...notification
  }: Omit<OmsNotification, "id" | "audience" | "expiryTime"> & {
    ttlMs: number;
  }) {
    const now = this.#options.clock();
    this.#publish({
      ...notification,
      id: `oms-${now.toString(36)}-${++this.#seq}`,
      audience: this.#accounts(notification.account)?.owner ?? "",
      expiryTime: now + ttlMs,
    });
  }
}
