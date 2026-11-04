import type { MarketTrade, TopOfBook } from "@heswell/exchange-sim";
import {
  AlgoStrategy,
  isTerminalStatus,
  isWorkingStatus,
  OrdStatus,
  RejectReason,
  roundToLot,
  type SessionSchedule,
  UNSCHEDULED,
} from "@heswell/trading-schemas";
import type { OrderEvent } from "../domain/orderState";
import type { ChildOrder, ParentOrder } from "../engine/OmsEngine";
import type { AlgoState } from "./params";
import { planSlice, type SliceRequest } from "./planSlice";
import { SLICE_STRATEGIES, type SliceStrategy } from "./strategies";

/** Slices before the end time in which the whole remainder is targeted. */
export const FINAL_SLICES = 2;

/** What the container needs from the OMS engine. */
export interface AlgoHost {
  clock(): number;
  schedule(): SessionSchedule;
  topOfBook(ric: string): TopOfBook | undefined;
  lotSize(ric: string): number | undefined;
  /** Non-terminal children of a parent. */
  liveChildren(parent: ParentOrder): ChildOrder[];
  sendChild(parent: ParentOrder, request: SliceRequest): void;
  cancelChild(child: ChildOrder): void;
  /** Apply an event to the parent (and publish it). */
  applyParent(parent: ParentOrder, event: OrderEvent): void;
  /** Publish the parent row after algo fields changed. */
  publishParent(parent: ParentOrder): void;
  log(message: string): void;
}

/** A parent order worked by a slicing strategy (any strategy but DMA). */
export type AlgoParent = ParentOrder & { algo: AlgoState };

export const isAlgoParent = (parent: ParentOrder): parent is AlgoParent =>
  parent.algo !== undefined &&
  parent.strategy !== undefined &&
  parent.strategy !== AlgoStrategy.Dma;

/**
 * Runs the algo strategies. Each running parent is sliced on `step()` (the
 * algo timer). Child events only advance the wind-down phases (amend,
 * cancel, finish), so a slice is never planned from half-updated state.
 * All algo state lives on the parent order, so it is journaled and
 * restored with it.
 */
export class AlgoContainer {
  readonly #host: AlgoHost;
  readonly #running = new Map<string, AlgoParent>();
  readonly sliceMs: number;

  constructor(host: AlgoHost, sliceMs: number) {
    this.#host = host;
    this.sliceMs = sliceMs;
  }

  get running(): readonly AlgoParent[] {
    return [...this.#running.values()];
  }

  /** Start working a new parent (already acknowledged). */
  start(parent: AlgoParent) {
    this.#running.set(parent.orderId, parent);
    this.#slice(parent, this.#host.clock());
  }

  /** Re-register running parents after a restore. */
  restore(parents: Iterable<ParentOrder>) {
    this.#running.clear();
    for (const parent of parents) {
      if (
        isAlgoParent(parent) &&
        parent.algo.phase !== "DONE" &&
        !isTerminalStatus(parent.state.status)
      ) {
        this.#running.set(parent.orderId, parent);
      }
    }
  }

  /** The algo timer: slice every working parent, advance the others. */
  step(now = this.#host.clock()) {
    for (const parent of [...this.#running.values()]) {
      if (parent.algo.phase === "WORKING") this.#slice(parent, now);
      else this.#windDown(parent);
    }
  }

  /** A child of `parent` changed (ack, fill, cancel, ...). */
  onChildEvent(parent: ParentOrder) {
    if (!isAlgoParent(parent)) return;
    this.#windDown(parent);
  }

  /** Market trade: POV counts the volume other traders do. */
  onTrade(trade: MarketTrade) {
    for (const parent of this.#running.values()) {
      if (
        parent.ric === trade.ric &&
        parent.algo.participation > 0 &&
        trade.timestamp >= parent.algo.startAt
      ) {
        parent.algo.marketVolume += trade.size;
      }
    }
  }

  /** Our own fills are on the tape too: take them out of the market volume. */
  onOwnFill(parent: ParentOrder, quantity: number) {
    if (isAlgoParent(parent) && parent.algo.participation > 0) {
      parent.algo.marketVolume = Math.max(
        0,
        parent.algo.marketVolume - quantity,
      );
    }
  }

  /**
   * Amend: the parent goes PENDING_REPLACE, live children are cancelled and
   * the new quantity / price applies once they are out (slicing resumes on
   * the new figures).
   */
  amend(parent: AlgoParent, quantity: number, price: number) {
    this.#host.applyParent(parent, { type: "pendingReplace", quantity, price });
    parent.algo.phase = "AMENDING";
    parent.algo.pendingAmend = { quantity, price };
    this.#windDown(parent);
  }

  /** Cancel: PENDING_CANCEL, cancel live children, then CANCELLED. */
  cancel(parent: AlgoParent) {
    this.#host.applyParent(parent, { type: "pendingCancel" });
    parent.algo.phase = "CANCELLING";
    this.#windDown(parent);
  }

  /** Stop and expire the remainder (end of window, end of day). */
  expire(parent: AlgoParent, text: string) {
    parent.algo.phase = "FINISHING";
    parent.algo.finishText = text;
    this.#windDown(parent);
  }

  #strategy(parent: AlgoParent): SliceStrategy | undefined {
    return SLICE_STRATEGIES[parent.strategy as keyof typeof SLICE_STRATEGIES];
  }

  #slice(parent: AlgoParent, now: number) {
    const host = this.#host;
    const { algo, state } = parent;
    if (isTerminalStatus(state.status)) {
      this.#windDown(parent);
      return;
    }
    if (algo.endAt > 0 && now >= algo.endAt) {
      const left = state.leavesQty;
      this.expire(parent, `algo end time reached with ${left} unfilled`);
      return;
    }
    const strategy = this.#strategy(parent);
    const lotSize = host.lotSize(parent.ric);
    if (!strategy || !lotSize) {
      this.expire(parent, `cannot run ${parent.strategy} on ${parent.ric}`);
      return;
    }
    const ctx = {
      algo,
      quantity: state.quantity,
      schedule: host.schedule() ?? UNSCHEDULED,
    };
    const raw = strategy.targetQty(ctx, now);
    const target = roundToLot(raw, lotSize, "down");
    if (target !== algo.targetQty) {
      algo.targetQty = target;
      host.publishParent(parent);
    }
    if (now < algo.startAt) return;

    // Final slices: everything should be done by the end time. Two slices,
    // because crossing first cancels the resting children and only trades
    // what they leave room for.
    const lastSlice =
      algo.endAt > 0 && now + FINAL_SLICES * this.sliceMs >= algo.endAt;
    let aheadRaw = strategy.targetQty(ctx, now + this.sliceMs);
    if (algo.participation > 0) {
      // POV has no clock schedule: lead by the recent participation rate.
      const elapsed = Math.max(this.sliceMs, now - algo.startAt);
      aheadRaw = raw + (raw / elapsed) * this.sliceMs * 2;
    }
    const ahead = Math.min(
      state.quantity,
      Math.max(lotSize, roundToLot(aheadRaw, lotSize, "up")),
    );
    const plan = planSlice({
      now,
      sliceMs: this.sliceMs,
      side: parent.side,
      limit: state.price,
      lotSize,
      quantity: state.quantity,
      cumQty: state.cumQty,
      target: lastSlice ? state.quantity : target,
      ahead: lastSlice ? state.quantity : ahead,
      finishing: lastSlice,
      top: host.topOfBook(parent.ric),
      children: host.liveChildren(parent).map((c) => ({
        orderId: c.orderId,
        price: c.state.price,
        leavesQty: c.state.leavesQty,
        status: c.state.status,
        created: c.created,
      })),
    });
    if (plan.cancel.length) {
      const ids = new Set(plan.cancel);
      for (const child of host.liveChildren(parent)) {
        if (ids.has(child.orderId)) host.cancelChild(child);
      }
    }
    // Cancels may have finished the parent (synchronous gateway).
    if (
      plan.send &&
      algo.phase === "WORKING" &&
      isWorkingStatus(state.status)
    ) {
      host.sendChild(parent, plan.send);
    }
  }

  /**
   * Advance a parent that is winding down: cancel its live children, and
   * once none are left apply the final parent event for the phase.
   */
  #windDown(parent: AlgoParent) {
    const host = this.#host;
    const { algo } = parent;
    if (algo.phase === "DONE") {
      this.#running.delete(parent.orderId);
      return;
    }
    const terminal = isTerminalStatus(parent.state.status);
    if (algo.phase === "WORKING" && !terminal) return;

    const live = host.liveChildren(parent);
    for (const child of live) {
      if (isWorkingStatus(child.state.status) && child.exchangeOrderId) {
        host.cancelChild(child);
      }
    }
    if (host.liveChildren(parent).length > 0) return;

    if (!terminal) {
      switch (algo.phase) {
        case "AMENDING": {
          const amend = algo.pendingAmend;
          algo.pendingAmend = undefined;
          algo.phase = "WORKING";
          if (amend && parent.state.cumQty <= amend.quantity) {
            host.applyParent(parent, { type: "replaced", ...amend });
          } else {
            host.applyParent(parent, {
              type: "replaceReject",
              reason: RejectReason.TooLateToAmend,
              text: "filled past the amended quantity",
            });
          }
          if (!isTerminalStatus(parent.state.status)) return;
          break;
        }
        case "CANCELLING":
          host.applyParent(parent, { type: "cancelled" });
          break;
        case "FINISHING":
          host.applyParent(parent, {
            type: "expired",
            text: algo.finishText,
          });
          break;
      }
    }
    algo.phase = "DONE";
    if (parent.state.status === OrdStatus.Filled) {
      algo.targetQty = parent.state.quantity;
    }
    host.publishParent(parent);
    this.#running.delete(parent.orderId);
  }
}
