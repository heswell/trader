import {
  AlgoStrategy,
  algoStrategyDefinition,
  allowedTimesInForce,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type EntryMessage,
  EntryMessageLevel,
  EntryRiskCode,
  encodeEntryMessages,
  entryFieldForCode,
  isPricedOrdType,
  isStopOrdType,
  isStrategyAllowed,
  isTimeInForceAllowed,
  nonStopOrdType,
  ORD_TYPE_LABEL,
  ORDER_ENTRY_EDITABLE_COLUMNS,
  type OpenOrderEntryRequest,
  OrdType,
  type OrderEntryEditableColumn,
  type OrderEntryResponse,
  RejectReason,
  REJECT_REASONS,
  type SendOrderRequest,
  Side,
  TimeInForce,
  TradingPhase,
  type UpdateOrderEntryRequest,
  validateOrder,
  validateRpcParams,
  validateStopTrigger,
} from "@heswell/trading-schemas";
import type { OmsEngine, OmsResult } from "../engine/OmsEngine";
import type { OmsGateway } from "../engine/gateway";
import type { TableSink } from "../modules/oms/TableSink";
import {
  type AccessScope,
  canSeeAccount,
  type TradingUser,
} from "../permissions/access";
import {
  referencePrice,
  type RiskInstrument,
  riskLimitBreaches,
} from "../risk/preTradeRisk";

/** The editable fields of an orderEntry row (numbers are 0 when empty). */
export interface OrderEntryFields {
  ric: string;
  side: Side;
  ordType: OrdType;
  timeInForce: TimeInForce;
  quantity: number;
  price: number;
  stopPrice: number;
  account: string;
  strategy: AlgoStrategy;
  durationMins: number;
  endTime: string;
  participationPct: number;
}

interface Draft extends OrderEntryFields {
  entryId: string;
  user: string;
  ticketId: string;
  clOrdId: string;
  orderId: string;
  lastUpdate: number;
  /** Why the OMS just changed a field for the user (cleared on the next edit). */
  notices: EntryMessage[];
  /** The reject of the last sendOrder (cleared on the next edit). */
  rejects: EntryMessage[];
  vuuMsg: string;
}

export const EMPTY_ORDER_ENTRY: Readonly<OrderEntryFields> = Object.freeze({
  ric: "",
  side: Side.Buy,
  ordType: OrdType.Limit,
  timeInForce: TimeInForce.Day,
  quantity: 0,
  price: 0,
  stopPrice: 0,
  account: "",
  strategy: AlgoStrategy.Dma,
  durationMins: 0,
  endTime: "",
  participationPct: 0,
});

const ALGO_PARAM_FIELDS = [
  "durationMins",
  "endTime",
  "participationPct",
] as const;

/** Default time an unused row is kept (ms). */
export const ORDER_ENTRY_IDLE_MS = 60 * 60 * 1000;

export interface OrderEntryServiceOptions {
  engine: OmsEngine;
  gateway: OmsGateway;
  tables: TableSink;
  accessFor: (user: TradingUser) => AccessScope;
  clock?: () => number;
  /** Rows unused for this long are deleted by refresh (default 1 hour). */
  idleMs?: number;
}

const fail = <T>(reason: RejectReason, text: string): OmsResult<T> => ({
  ok: false,
  reason,
  text,
});

const sentence = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

const error = (field: string, code: string, text: string): EntryMessage => ({
  level: EntryMessageLevel.Error,
  field,
  code,
  text: sentence(text),
});

const info = (field: string, code: string, text: string): EntryMessage => ({
  level: EntryMessageLevel.Info,
  field,
  code,
  text,
});

const isRejectReason = (code: string): code is RejectReason =>
  (REJECT_REASONS as readonly string[]).includes(code);

/** The createOrder reject a message stands for. */
const rejectReasonOf = (code: string): RejectReason =>
  isRejectReason(code)
    ? code
    : code === EntryRiskCode.Collar
      ? RejectReason.PriceOutsideCollar
      : code === EntryRiskCode.MaxOrderQty
        ? RejectReason.ExceedsMaxQuantity
        : code === EntryRiskCode.MaxOrderNotional ||
            code === EntryRiskCode.MaxPositionNotional
          ? RejectReason.ExceedsMaxNotional
          : RejectReason.InvalidRequest;

/** The draft fields present in a request (undefined values left out). */
const fieldsOf = (
  request: Partial<Record<OrderEntryEditableColumn, unknown>>,
): Partial<OrderEntryFields> => {
  const fields: Record<string, unknown> = {};
  for (const column of ORDER_ENTRY_EDITABLE_COLUMNS) {
    if (request[column] !== undefined) fields[column] = request[column];
  }
  return fields as Partial<OrderEntryFields>;
};

let clOrdIdSeq = 0;

/**
 * Order ticket rows (the orderEntry table): one row per user and ticket,
 * edited a field at a time (editCell on the orderEntryPrices join) or
 * several at once (updateOrderEntry). Every edit is stored, then checked
 * against the same rules createOrder applies; the result is written to the
 * row's vuuMsg (encodeEntryMessages). sendOrder turns the row into a
 * createOrder. The trading server and the engine-local data both use it.
 */
export class OrderEntryService {
  readonly #engine: OmsEngine;
  readonly #gateway: OmsGateway;
  readonly #tables: TableSink;
  readonly #accessFor: (user: TradingUser) => AccessScope;
  readonly #clock: () => number;
  readonly #idleMs: number;
  readonly #drafts = new Map<string, Draft>();
  /** Users by name, kept for the refresh (access can depend on roles). */
  readonly #users = new Map<string, TradingUser>();

  constructor({
    engine,
    gateway,
    tables,
    accessFor,
    clock = Date.now,
    idleMs = ORDER_ENTRY_IDLE_MS,
  }: OrderEntryServiceOptions) {
    this.#engine = engine;
    this.#gateway = gateway;
    this.#tables = tables;
    this.#accessFor = accessFor;
    this.#clock = clock;
    this.#idleMs = idleMs;
  }

  /** Key of a user's row for a ticket. */
  static entryId(user: string, ticketId: string) {
    return `${user}:${ticketId}`;
  }

  get size() {
    return this.#drafts.size;
  }

  /** The row's fields and messages (tests, diagnostics). */
  get(entryId: string): Readonly<Draft> | undefined {
    return this.#drafts.get(entryId);
  }

  /**
   * Open the user's row for a ticket. With any draft field the row is reset
   * to them (defaults for the rest); without, an existing row is kept.
   */
  open(
    user: TradingUser,
    request: OpenOrderEntryRequest,
  ): OmsResult<OrderEntryResponse> {
    const entryId = OrderEntryService.entryId(user.name, request.ticketId);
    this.#users.set(user.name, user);
    const fields = fieldsOf(request);
    const existing = this.#drafts.get(entryId);
    if (existing && Object.keys(fields).length === 0) {
      existing.lastUpdate = this.#clock();
      this.#write(existing, { lastUpdate: existing.lastUpdate });
      return { ok: true, value: { entryId } };
    }
    const draft: Draft = {
      ...EMPTY_ORDER_ENTRY,
      entryId,
      user: user.name,
      ticketId: request.ticketId,
      account: existing?.account || this.#defaultAccount(user),
      clOrdId: existing?.clOrdId ?? "",
      orderId: existing?.orderId ?? "",
      lastUpdate: this.#clock(),
      notices: [],
      rejects: [],
      vuuMsg: "",
    };
    this.#apply(draft, fields, { tifFallback: true });
    draft.notices = [];
    this.#drafts.set(entryId, draft);
    this.#writeAll(draft);
    return { ok: true, value: { entryId } };
  }

  /** Set several fields at once (the knock-on rules run once, after all). */
  update(
    user: TradingUser,
    request: UpdateOrderEntryRequest,
  ): OmsResult<OrderEntryResponse> {
    const draft = this.#owned(user, request.entryId);
    if (!draft.ok) return draft;
    this.#users.set(user.name, user);
    this.#apply(draft.value, fieldsOf(request));
    this.#writeAll(draft.value);
    return { ok: true, value: { entryId: request.entryId } };
  }

  /**
   * Check one editCell before it is applied: the row is the user's, the
   * column is a draft field and the value has the right type (business rules
   * are reported in vuuMsg, not refused). Returns the reason to refuse it.
   */
  checkEdit(
    user: TradingUser,
    entryId: string,
    column: string,
    value: unknown,
  ): string | undefined {
    const draft = this.#owned(user, entryId);
    if (!draft.ok) return `${draft.reason}: ${draft.text}`;
    if (!(ORDER_ENTRY_EDITABLE_COLUMNS as readonly string[]).includes(column)) {
      return `${RejectReason.InvalidRequest}: ${column} is not editable`;
    }
    const valid = validateRpcParams("updateOrderEntry", {
      entryId,
      [column]: value,
    });
    return valid.ok
      ? undefined
      : `${RejectReason.InvalidRequest}: ${valid.errors.join("; ")}`;
  }

  /** Apply one checked editCell. */
  editCell(
    user: TradingUser,
    entryId: string,
    column: string,
    value: unknown,
  ): OmsResult<OrderEntryResponse> {
    const invalid = this.checkEdit(user, entryId, column, value);
    if (invalid) {
      const i = invalid.indexOf(":");
      return fail(
        invalid.slice(0, i) as RejectReason,
        invalid.slice(i + 1).trim(),
      );
    }
    const valid = validateRpcParams("updateOrderEntry", {
      entryId,
      [column]: value,
    });
    if (!valid.ok) return fail(RejectReason.InvalidRequest, valid.errors[0]);
    return this.update(user, valid.value);
  }

  /**
   * Send the row as an order. Refused while it has errors, or warnings that
   * need review unless `confirmed`. A reject is written to vuuMsg; success
   * records the order and clears the quantity, ready for the next order.
   */
  send(
    user: TradingUser,
    request: SendOrderRequest,
  ): OmsResult<CreateOrderResponse> {
    const owned = this.#owned(user, request.entryId);
    if (!owned.ok) return owned;
    const draft = owned.value;
    this.#users.set(user.name, user);
    draft.rejects = [];
    const messages = this.messages(draft);
    const blocking = messages.find((m) => m.level === EntryMessageLevel.Error);
    if (blocking) {
      this.#writeMessages(draft, messages);
      return fail(rejectReasonOf(blocking.code), blocking.text);
    }
    const review = messages.filter((m) => m.level === EntryMessageLevel.Review);
    if (review.length > 0 && !request.confirmed) {
      return fail(
        RejectReason.InvalidRequest,
        `review needed: ${review.map((m) => m.text).join("; ")}`,
      );
    }
    const params = validateRpcParams("createOrder", {
      ...this.#orderParams(draft),
      clOrdId:
        request.clOrdId ??
        `TKT-${this.#clock().toString(36)}-${(++clOrdIdSeq).toString(36)}`.toUpperCase(),
    });
    if (!params.ok) {
      return this.#rejected(
        draft,
        RejectReason.InvalidRequest,
        params.errors.join("; "),
      );
    }
    const result = this.#engine.createOrder(params.value, {
      user: user.name,
      access: this.#accessFor(user),
    });
    if (!result.ok) {
      if (result.orderId) {
        draft.clOrdId = params.value.clOrdId ?? "";
        draft.orderId = result.orderId;
      }
      return this.#rejected(draft, result.reason, result.text);
    }
    draft.clOrdId = params.value.clOrdId ?? "";
    draft.orderId = result.value.orderId;
    draft.quantity = 0;
    draft.notices = [];
    draft.lastUpdate = this.#clock();
    this.#writeAll(draft);
    return {
      ok: true,
      value: {
        orderId: result.value.orderId,
        clOrdId: result.value.clOrdId,
        status: result.value.status,
      },
    };
  }

  /** Delete the user's row. */
  close(user: TradingUser, entryId: string): OmsResult<OrderEntryResponse> {
    const draft = this.#owned(user, entryId);
    if (!draft.ok) return draft;
    this.#drafts.delete(entryId);
    this.#tables.deleteRow("orderEntry", entryId);
    return { ok: true, value: { entryId } };
  }

  /**
   * Rebuild every row's messages (prices and phases move without an edit),
   * writing only those that changed, and delete rows idle for idleMs.
   */
  refresh(now = this.#clock()) {
    for (const draft of this.#drafts.values()) {
      if (now - draft.lastUpdate > this.#idleMs) {
        this.#drafts.delete(draft.entryId);
        this.#tables.deleteRow("orderEntry", draft.entryId);
      } else {
        this.#writeMessages(draft, this.messages(draft));
      }
    }
  }

  /**
   * Errors and notes for a row, in field order: what createOrder would
   * reject, then the account limits and collar, then the OMS's notices and
   * the last reject.
   */
  messages(draft: Draft): EntryMessage[] {
    const messages: EntryMessage[] = [];
    const has = (field: string) => messages.some((m) => m.field === field);
    const instrument = draft.ric
      ? this.#gateway.getInstrument(draft.ric)
      : undefined;
    const phase = this.#phase(draft.ric);

    if (!draft.ric) {
      messages.push(
        error("ric", RejectReason.UnknownInstrument, "Select an instrument"),
      );
    } else if (!instrument) {
      messages.push(
        error(
          "ric",
          RejectReason.UnknownInstrument,
          `unknown instrument ${draft.ric}`,
        ),
      );
    } else if (this.#engine.restricted.has(draft.ric)) {
      messages.push(
        error(
          "ric",
          RejectReason.RestrictedInstrument,
          `${draft.ric} is on the restricted list`,
        ),
      );
    }

    const user = this.#users.get(draft.user);
    const account = this.#engine.accounts.get(draft.account);
    if (!draft.account) {
      messages.push(
        error("account", RejectReason.UnknownAccount, "Select an account"),
      );
    } else if (!account) {
      messages.push(
        error(
          "account",
          RejectReason.UnknownAccount,
          `account ${draft.account} is not available`,
        ),
      );
    } else if (!account.enabled) {
      messages.push(
        error(
          "account",
          RejectReason.AccountDisabled,
          `account ${draft.account} is disabled`,
        ),
      );
    } else if (user) {
      const access = this.#accessFor(user);
      if (!(access.canExecute && canSeeAccount(access, draft.account))) {
        messages.push(
          error(
            "account",
            RejectReason.PermissionDenied,
            `${user.name} may not trade account ${draft.account}`,
          ),
        );
      }
    }

    if (!(draft.quantity > 0)) {
      messages.push(
        error("quantity", RejectReason.InvalidQuantity, "Enter a quantity"),
      );
    }
    const priced = isPricedOrdType(draft.ordType);
    const stop = isStopOrdType(draft.ordType);
    if (priced && !(draft.price > 0)) {
      messages.push(
        error("price", RejectReason.MissingPrice, "Enter a limit price"),
      );
    }
    if (stop && !(draft.stopPrice > 0)) {
      messages.push(
        error("stopPrice", RejectReason.MissingStopPrice, "Enter a stop price"),
      );
    }
    if (!isStrategyAllowed(draft.ordType, draft.strategy)) {
      messages.push(
        error(
          "strategy",
          RejectReason.UnsupportedOrdType,
          "Stop orders are DMA only",
        ),
      );
    }
    const definition = algoStrategyDefinition(draft.strategy);
    if (!definition.timeInForce.includes(draft.timeInForce)) {
      messages.push(
        error(
          "timeInForce",
          RejectReason.UnsupportedTimeInForce,
          `${draft.timeInForce} is not valid for ${definition.name} orders`,
        ),
      );
    }
    for (const param of definition.params) {
      const value = draft[param.key];
      const empty = value === 0 || value === "";
      if (empty) {
        if (param.required) {
          messages.push(
            error(
              param.key,
              RejectReason.InvalidRequest,
              `Enter ${param.label.toLowerCase()}`,
            ),
          );
        }
      } else if (
        param.type === "time" &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))
      ) {
        messages.push(
          error(
            param.key,
            RejectReason.InvalidRequest,
            `${param.label} must be HH:MM`,
          ),
        );
      } else if (
        typeof value === "number" &&
        ((param.min !== undefined && value < param.min) ||
          (param.max !== undefined && value > param.max))
      ) {
        messages.push(
          error(
            param.key,
            RejectReason.InvalidRequest,
            `${param.label} must be ${param.min} to ${param.max}${param.type === "percent" ? "%" : " minutes"}`,
          ),
        );
      }
    }

    // The instrument rules (tick, lot, type, phase), as createOrder applies them.
    if (
      instrument &&
      !has("ric") &&
      !has("quantity") &&
      !has("price") &&
      !has("stopPrice")
    ) {
      const order = this.#riskOrder(draft);
      const invalid =
        validateOrder(order, instrument, phase) ??
        (stop
          ? validateStopTrigger(
              draft.side,
              draft.stopPrice,
              referencePrice(instrument, this.#gateway.getTopOfBook(draft.ric)),
            )
          : undefined);
      if (invalid) {
        messages.push(
          error(
            entryFieldForCode(invalid.reason),
            invalid.reason,
            invalid.text,
          ),
        );
      } else if (account?.enabled && !has("account")) {
        const ctx = this.#engine.riskContext(draft.account, draft.ric);
        for (const breach of riskLimitBreaches(
          order,
          account,
          instrument,
          ctx,
        )) {
          messages.push(
            error(entryFieldForCode(breach.code), breach.code, breach.text),
          );
        }
      }
    }
    return [...messages, ...draft.notices, ...draft.rejects];
  }

  // ---------------------------------------------------------------- private

  #owned(user: TradingUser, entryId: string): OmsResult<Draft> {
    const draft = this.#drafts.get(entryId);
    if (!draft || draft.user !== user.name) {
      return fail(RejectReason.InvalidRequest, `no order entry ${entryId}`);
    }
    return { ok: true, value: draft };
  }

  #defaultAccount(user: TradingUser) {
    const access = this.#accessFor(user);
    for (const account of this.#engine.accounts.values()) {
      if (
        account.enabled &&
        access.canExecute &&
        canSeeAccount(access, account.account)
      ) {
        return account.account;
      }
    }
    return "";
  }

  #phase(ric: string): TradingPhase {
    if (!ric) return TradingPhase.Continuous;
    return (
      this.#gateway.getTopOfBook(ric)?.phase ??
      this.#gateway.getPhase(ric) ??
      TradingPhase.Continuous
    );
  }

  /**
   * Apply changed fields, then the knock-on rules the ticket has always had:
   * a new instrument clears the prices, an order type without a price
   * clears it, stops are DMA only (the choice just made wins), a new
   * strategy clears its parameters, and a time in force the new type or
   * strategy can't take falls back to DAY.
   */
  #apply(
    draft: Draft,
    change: Partial<OrderEntryFields>,
    { tifFallback = false } = {},
  ) {
    const before: OrderEntryFields = { ...draft };
    Object.assign(draft, change);
    draft.notices = [];
    draft.rejects = [];
    draft.lastUpdate = this.#clock();

    if (change.ric !== undefined && change.ric !== before.ric) {
      if (change.price === undefined) draft.price = 0;
      if (change.stopPrice === undefined) draft.stopPrice = 0;
    }
    if (change.strategy !== undefined && change.strategy !== before.strategy) {
      for (const key of ALGO_PARAM_FIELDS) {
        if (change[key] === undefined)
          (draft[key] as unknown) = EMPTY_ORDER_ENTRY[key];
      }
    }
    if (
      (change.ordType !== undefined || change.strategy !== undefined) &&
      !isStrategyAllowed(draft.ordType, draft.strategy)
    ) {
      if (change.ordType === undefined) {
        draft.ordType = nonStopOrdType(draft.ordType);
        draft.notices.push(
          info(
            "ordType",
            "TYPE_CHANGED",
            `Stops are DMA only: switched to ${ORD_TYPE_LABEL[draft.ordType]}`,
          ),
        );
      } else {
        draft.strategy = AlgoStrategy.Dma;
        for (const key of ALGO_PARAM_FIELDS) {
          (draft[key] as unknown) = EMPTY_ORDER_ENTRY[key];
        }
        draft.notices.push(
          info(
            "strategy",
            "STRATEGY_CHANGED",
            "Stops are DMA only: switched to DMA",
          ),
        );
      }
    }
    if (draft.ordType !== before.ordType) {
      if (!isPricedOrdType(draft.ordType) && change.price === undefined)
        draft.price = 0;
      if (!isStopOrdType(draft.ordType) && change.stopPrice === undefined)
        draft.stopPrice = 0;
    }
    if (
      change.timeInForce === undefined &&
      (tifFallback ||
        draft.ordType !== before.ordType ||
        draft.strategy !== before.strategy)
    ) {
      const phase = this.#phase(draft.ric);
      if (
        !isTimeInForceAllowed(
          draft.ordType,
          draft.timeInForce,
          draft.strategy,
          phase,
        )
      ) {
        const valid = allowedTimesInForce(draft.ordType, draft.strategy, phase);
        const tif = valid.includes(TimeInForce.Day)
          ? TimeInForce.Day
          : (valid[0] ?? TimeInForce.Day);
        draft.notices.push(
          info(
            "timeInForce",
            "TIF_CHANGED",
            `${draft.timeInForce} isn't valid for ${
              draft.strategy !== before.strategy
                ? algoStrategyDefinition(draft.strategy).name
                : draft.ordType === OrdType.Market
                  ? "market orders"
                  : isStopOrdType(draft.ordType)
                    ? "stop orders"
                    : "this order"
            }`,
          ),
        );
        draft.timeInForce = tif;
      }
    }
  }

  /** The order a row describes, as the risk check reads it. */
  #riskOrder(draft: Draft) {
    return {
      account: draft.account,
      ric: draft.ric,
      side: draft.side,
      ordType: draft.ordType,
      quantity: draft.quantity,
      price: isPricedOrdType(draft.ordType) ? draft.price : 0,
      stopPrice: isStopOrdType(draft.ordType) ? draft.stopPrice : undefined,
      timeInForce: draft.timeInForce,
    };
  }

  /** createOrder params of a row (without clOrdId). */
  #orderParams(draft: Draft): Omit<CreateOrderRequest, "clOrdId"> {
    const params: Record<string, unknown> = { ...this.#riskOrder(draft) };
    if (!isPricedOrdType(draft.ordType)) delete params.price;
    if (params.stopPrice === undefined) delete params.stopPrice;
    if (draft.strategy !== AlgoStrategy.Dma) {
      params.strategy = draft.strategy;
      for (const param of algoStrategyDefinition(draft.strategy).params) {
        const value = draft[param.key];
        if (value !== 0 && value !== "") params[param.key] = value;
      }
    }
    return params as Omit<CreateOrderRequest, "clOrdId">;
  }

  #rejected<T>(draft: Draft, reason: RejectReason, text: string): OmsResult<T> {
    // The last reject is news about a send, not an error in the draft.
    draft.rejects = [info(entryFieldForCode(reason), reason, text)];
    draft.lastUpdate = this.#clock();
    this.#writeAll(draft);
    return fail(reason, text);
  }

  /** Instrument static columns of a row (empty when unknown). */
  #static(instrument: RiskInstrument | undefined) {
    const extra = instrument as
      | (RiskInstrument & { description?: string; priceDecimals?: number })
      | undefined;
    return {
      description: extra?.description ?? "",
      exchange: instrument?.exchange ?? "",
      currency: instrument?.currency ?? "",
      instrumentType: instrument?.instrumentType ?? "",
      contract: instrument?.contract ?? "",
      tickSize: instrument?.tickSize ?? 0,
      tickBands: instrument?.tickBands ?? "",
      lotSize: instrument?.lotSize ?? 0,
      priceDecimals: extra?.priceDecimals ?? 0,
      contractMultiplier: instrument?.contractMultiplier ?? 1,
      refPrice: instrument?.refPrice ?? 0,
    };
  }

  #writeAll(draft: Draft) {
    draft.vuuMsg = encodeEntryMessages(this.messages(draft));
    const instrument = draft.ric
      ? this.#gateway.getInstrument(draft.ric)
      : undefined;
    this.#write(draft, {
      entryId: draft.entryId,
      user: draft.user,
      ticketId: draft.ticketId,
      ric: draft.ric,
      side: draft.side,
      ordType: draft.ordType,
      timeInForce: draft.timeInForce,
      quantity: draft.quantity,
      price: draft.price,
      stopPrice: draft.stopPrice,
      account: draft.account,
      strategy: draft.strategy,
      durationMins: draft.durationMins,
      endTime: draft.endTime,
      participationPct: draft.participationPct,
      ...this.#static(instrument),
      clOrdId: draft.clOrdId,
      orderId: draft.orderId,
      lastUpdate: draft.lastUpdate,
      vuuMsg: draft.vuuMsg,
    });
  }

  #writeMessages(draft: Draft, messages: EntryMessage[]) {
    const vuuMsg = encodeEntryMessages(messages);
    if (vuuMsg === draft.vuuMsg) return;
    draft.vuuMsg = vuuMsg;
    this.#write(draft, { vuuMsg });
  }

  #write(draft: Draft, values: Record<string, unknown>) {
    this.#tables.orderEntry({ entryId: draft.entryId, ...values });
  }
}
