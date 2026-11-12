import {
  type AlgoParamDefinition,
  AlgoStrategy,
  algoStrategyDefinition,
  isPricedOrdType,
  isStopOrdType,
  OrdStatus,
  OrdType,
  type Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type TradingConnectionState,
  useTradingConnectionStatus,
} from "../../connection/useTradingConnectionStatus";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import { filterString } from "../../utils/filters";
import type { LinkGroupId } from "../../instrument-context/linkGroups";
import type { TradingRow } from "../../data/useDataSourceRows";
import { useTradingRows } from "../../data/useTradingRows";
import {
  type SelectedInstrument,
  useSelectedInstrument,
} from "../../instrument-context/InstrumentContext";
import { orderEventFromParentOrder } from "../../notifications/orderEventTrackers";
import {
  orderEventKindForStatus,
  type TradingOrderEvent,
} from "../../notifications/tradingOrderEvents";
import { useTradingNotifications } from "../../notifications/TradingNotificationsProvider";
import {
  type AlgoParamKey,
  allowedTimesInForce,
  EMPTY_DRAFT,
  fieldForRejectReason,
  formatPriceInput,
  isPriceShorthand,
  isStrategyAllowed,
  isTimeInForceAllowed,
  nonStopOrdType,
  nudgeStopPrice,
  ORD_TYPE_LABEL,
  isValueInput,
  parseAlgoParam,
  parseOrderLine,
  parseTimeInput,
  resolvePriceInput,
  resolveQuantityInput,
  reviewReasons,
  newClOrdId,
  nudgePrice,
  nudgeQuantity,
  type OrderDraft,
  type OrderDraftErrors,
  type OrderDraftField,
  type OrderTicketAccount,
  type OrderTicketInstrument,
  previewRisk,
  type RiskPreviewOptions,
  validateDraft,
} from "./orderTicketModel";

/**
 * Values to open a ticket with (from a grid Buy/Sell action, a ladder click,
 * a position row ...). Anything omitted keeps its default.
 */
export interface OrderTicketPrefill {
  ric?: string;
  /** Static data for the ric, if the caller has it (saves a lookup). */
  instrument?: SelectedInstrument;
  side?: Side;
  /** Limit price; implies a LIMIT order unless ordType is given. */
  price?: number;
  /**
   * Stop (trigger) price; implies a STOP order (STOP_LIMIT with a price)
   * unless ordType is given.
   */
  stopPrice?: number;
  quantity?: number;
  ordType?: OrdType;
  timeInForce?: TimeInForce;
  account?: string;
  /** How the OMS works the order (default DMA; stops are DMA only). */
  strategy?: AlgoStrategy;
}

/**
 * Why the ticket just changed the order type or strategy for you: stops are
 * DMA only, so picking one of them resets the other (`field` is the one
 * that was changed).
 */
export interface OrderTicketTypeNotice {
  field: "ordType" | "strategy";
  text: string;
}

export type OrderTicketSubmission =
  | { state: "idle" }
  | { state: "pending"; clOrdId: string }
  | {
      state: "accepted";
      clOrdId: string;
      orderId: string;
      /** Status from the createOrder result (live status: `order`). */
      status: OrdStatus;
    }
  | { state: "rejected"; clOrdId: string; reason: string; text: string };

export interface UseOrderTicketProps extends RiskPreviewOptions {
  prefill?: OrderTicketPrefill;
  /** Follow the selected instrument (useSelectedInstrument). Default true. */
  followSelection?: boolean;
  /**
   * Link group (channel) whose selection is followed / published. Default:
   * the inherited group (LinkGroupProvider / InstrumentContextProvider).
   */
  linkGroup?: LinkGroupId;
  /** Publish instruments picked in the ticket as the selection. Default true. */
  publishSelection?: boolean;
  /** Called for each order event of orders sent from this ticket. */
  onOrderEvent?: (event: TradingOrderEvent) => void;
  /** Called on Escape with nothing to reset (close the dialog / panel). */
  onClose?: () => void;
  /** Report events to the TradingNotificationsProvider. Default true. */
  notify?: boolean;
  /** Remember the last account used (localStorage). Default true. */
  rememberAccount?: boolean;
  /** clOrdId prefix (default "TKT"). */
  clOrdIdPrefix?: string;
}

export const ORDER_TICKET_SELECTION_SOURCE = "orderTicket";
export const LAST_ACCOUNT_STORAGE_KEY = "trading.orderTicket.lastAccount";

const INSTRUMENT_PRICE_COLUMNS = [
  "ric",
  "description",
  "currency",
  "exchange",
  "tickSize",
  "tickBands",
  "lotSize",
  "priceDecimals",
  "instrumentType",
  "contract",
  "contractMultiplier",
  "refPrice",
  "bid",
  "ask",
  "bidSize",
  "askSize",
  "last",
  "close",
  "change",
  "changePct",
  "phase",
  "timestamp",
];
const ACCOUNT_COLUMNS = [
  "account",
  "name",
  "desk",
  "owner",
  "currency",
  "maxOrderQty",
  "maxOrderNotional",
  "maxPositionNotional",
  "enabled",
];
const ORDER_COLUMNS = [
  "orderId",
  "clOrdId",
  "ric",
  "side",
  "ordType",
  "quantity",
  "price",
  "status",
  "cumQty",
  "leavesQty",
  "avgPx",
  "account",
  "currency",
  "rejectReason",
  "text",
  "version",
  "strategy",
  "targetQty",
  "stopPrice",
  "triggeredAt",
];

const NO_ORDER_FILTER = 'clOrdId = "-"';
const NO_POSITION_FILTER = 'ric = "-"';

const readLastAccount = () => {
  try {
    return (
      globalThis.localStorage?.getItem(LAST_ACCOUNT_STORAGE_KEY) ?? undefined
    );
  } catch {
    return undefined;
  }
};
const writeLastAccount = (account: string) => {
  try {
    globalThis.localStorage?.setItem(LAST_ACCOUNT_STORAGE_KEY, account);
  } catch {
    // storage unavailable (private mode, sandboxed iframe)
  }
};

/** A draft from a prefill (anything unset takes the empty draft's value). */
export const draftFromPrefill = (
  prefill: OrderTicketPrefill | undefined,
  fallback: { ric?: string; account?: string } = {},
): OrderDraft => {
  const ordType =
    prefill?.ordType ??
    (prefill?.stopPrice !== undefined
      ? prefill.price !== undefined
        ? OrdType.StopLimit
        : OrdType.Stop
      : prefill?.price !== undefined
        ? OrdType.Limit
        : EMPTY_DRAFT.ordType);
  const timeInForce = prefill?.timeInForce ?? EMPTY_DRAFT.timeInForce;
  // Stops are DMA only.
  const strategy = isStrategyAllowed(ordType, prefill?.strategy)
    ? (prefill?.strategy ?? EMPTY_DRAFT.strategy)
    : AlgoStrategy.Dma;
  return {
    ric: prefill?.ric ?? prefill?.instrument?.ric ?? fallback.ric,
    side: prefill?.side ?? EMPTY_DRAFT.side,
    ordType,
    timeInForce: isTimeInForceAllowed(ordType, timeInForce, strategy)
      ? timeInForce
      : TimeInForce.Day,
    quantity: prefill?.quantity !== undefined ? String(prefill.quantity) : "",
    price:
      prefill?.price !== undefined && isPricedOrdType(ordType)
        ? formatPriceInput(prefill.price, prefill.instrument)
        : "",
    stopPrice:
      prefill?.stopPrice !== undefined && isStopOrdType(ordType)
        ? formatPriceInput(prefill.stopPrice, prefill.instrument)
        : "",
    account: prefill?.account ?? fallback.account,
    strategy,
    algoParams: {},
  };
};

const toInstrument = (row: TradingRow | undefined) =>
  row as unknown as OrderTicketInstrument | undefined;

/** Why orders cannot be sent in this connection state, else undefined. */
export const connectionBlockedReason = (
  state: TradingConnectionState,
): string | undefined => {
  switch (state) {
    case "connected":
      return undefined;
    case "connecting":
      return "Connecting to the trading server…";
    case "reconnecting":
      return "Connection lost, reconnecting: orders cannot be sent";
    default:
      return "Not connected to the trading server: orders cannot be sent";
  }
};

const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

/** `data-order-ticket-field` of a strategy parameter input. */
export const algoParamField = (key: AlgoParamKey) => `param:${key}`;

/** Ticket fields in tab order: the next one after `from`, or the submit button. */
const nextField = (root: HTMLElement, from: HTMLElement) => {
  const fields = Array.from(
    root.querySelectorAll<HTMLElement>("[data-order-ticket-field]"),
  ).filter(
    (el) =>
      !(el as HTMLInputElement).disabled &&
      el.getAttribute("aria-hidden") !== "true",
  );
  const i = fields.findIndex((el) => el === from || el.contains(from));
  return fields[i + 1];
};

/**
 * Focus a ticket field and select its text, as Tab does, so typing
 * replaces the value rather than appending to it.
 */
export const focusTicketField = (el: HTMLElement | null | undefined) => {
  if (!el) return;
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
};

/** Step a strategy parameter's input by `steps` (5 min, 1 %, 5 min of time). */
const stepAlgoParam = (
  param: AlgoParamDefinition,
  text: string | undefined,
  steps: number,
): string | undefined => {
  const clamp = (v: number) =>
    Math.min(param.max ?? v, Math.max(param.min ?? v, v));
  const { value } = parseAlgoParam(param, text);
  switch (param.type) {
    case "duration": {
      const v =
        typeof value === "number" ? value : Number(param.placeholder) || 30;
      return String(clamp(v + steps * 5));
    }
    case "percent": {
      const v =
        typeof value === "number" ? value : Number(param.placeholder) || 10;
      return String(clamp(v + steps));
    }
    case "time": {
      const hhmm = typeof value === "string" ? value : parseTimeInput("16:30");
      if (!hhmm) return undefined;
      const [h, m] = hhmm.split(":").map(Number);
      const mins = Math.min(23 * 60 + 55, Math.max(0, h * 60 + m + steps * 5));
      return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    }
  }
};

/**
 * State and behaviour of the order ticket (one core used by every layout
 * variant). Exposed for custom ticket layouts.
 */
export const useOrderTicket = ({
  prefill,
  followSelection = true,
  linkGroup,
  publishSelection = true,
  onOrderEvent,
  onClose,
  notify: notifyEnabled = true,
  rememberAccount = true,
  clOrdIdPrefix,
  usdPerPriceUnit,
  collarPct,
}: UseOrderTicketProps = {}) => {
  const { selectedInstrument, selectionSource, setSelectedInstrument } =
    useSelectedInstrument({ linkGroup });
  const notifications = useTradingNotifications();
  const { state: connectionState } = useTradingConnectionStatus();
  const blockedReason = connectionBlockedReason(connectionState);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed per prefill only
  const initialDraft = useMemo(
    () =>
      draftFromPrefill(prefill, {
        ric: followSelection ? selectedInstrument?.ric : undefined,
      }),
    [prefill],
  );
  const [draft, setDraft] = useState<OrderDraft>(initialDraft);
  const [baseline, setBaseline] = useState<OrderDraft>(initialDraft);
  const [touched, setTouched] = useState<
    Partial<Record<OrderDraftField, boolean>>
  >({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submission, setSubmission] = useState<OrderTicketSubmission>({
    state: "idle",
  });
  /** Set when a change made the TIF invalid and it was switched to Day. */
  const [tifNotice, setTifNotice] = useState<string | undefined>();
  /** Set when a stop / algo conflict changed the order type or strategy. */
  const [typeNotice, setTypeNotice] = useState<
    OrderTicketTypeNotice | undefined
  >();
  /** The Review step is open (warnings that need a second look). */
  const [reviewing, setReviewing] = useState(false);

  // A new prefill replaces the draft.
  const prefillRef = useRef(prefill);
  useEffect(() => {
    if (prefillRef.current === prefill) return;
    prefillRef.current = prefill;
    setDraft((current) => {
      const next = draftFromPrefill(prefill, {
        ric: current.ric,
        account: current.account,
      });
      setBaseline(next);
      return next;
    });
    setTouched({});
    setSubmitAttempted(false);
    setSubmission({ state: "idle" });
  }, [prefill]);

  // Follow selections made elsewhere.
  useEffect(() => {
    if (
      !followSelection ||
      !selectedInstrument ||
      selectionSource === ORDER_TICKET_SELECTION_SOURCE
    ) {
      return;
    }
    setDraft((current) =>
      current.ric === selectedInstrument.ric
        ? current
        : {
            ...current,
            ric: selectedInstrument.ric,
            price: "",
            stopPrice: "",
          },
    );
  }, [followSelection, selectedInstrument, selectionSource]);

  // Live instrument (static + prices).
  const { rows: instrumentRows } = useTradingRows("instrumentPrices", {
    columns: INSTRUMENT_PRICE_COLUMNS,
    filter: `ric = ${filterString(draft.ric ?? "-")}`,
    rowCount: 1,
  });
  const instrument = useMemo(() => {
    const row = toInstrument(instrumentRows[0]);
    return row?.ric === draft.ric ? row : undefined;
  }, [instrumentRows, draft.ric]);
  const phaseRef = useRef<string | undefined>(undefined);
  phaseRef.current = instrument?.phase;

  // Accounts visible to the user (disabled accounts excluded).
  const { rows: accountRows } = useTradingRows("accounts", {
    columns: ACCOUNT_COLUMNS,
    rowCount: 200,
  });
  const accounts = useMemo(
    () =>
      (accountRows as unknown as OrderTicketAccount[]).filter(
        (a) => a.enabled !== false,
      ),
    [accountRows],
  );
  useEffect(() => {
    if (accounts.length === 0) return;
    setDraft((current) => {
      if (
        current.account &&
        accounts.some((a) => a.account === current.account)
      )
        return current;
      const remembered = rememberAccount ? readLastAccount() : undefined;
      const account =
        (remembered &&
          accounts.find((a) => a.account === remembered)?.account) ??
        accounts[0].account;
      setBaseline((b) => (b.account ? b : { ...b, account }));
      return { ...current, account };
    });
  }, [accounts, rememberAccount]);
  const account = accounts.find((a) => a.account === draft.account);

  // The account's position in the instrument (shown beside quantity).
  const { rows: positionRows } = useTradingRows("positions", {
    columns: ["account", "ric", "quantity"],
    filter:
      draft.account && draft.ric
        ? `account = ${filterString(draft.account)} and ric = ${filterString(draft.ric)}`
        : NO_POSITION_FILTER,
    rowCount: 1,
  });
  const position =
    positionRows[0]?.ric === draft.ric &&
    positionRows[0]?.account === draft.account
      ? (positionRows[0]?.quantity as number | undefined)
      : undefined;

  // The submitted order (also the OMS data source used for the RPC).
  const clOrdId = submission.state === "idle" ? undefined : submission.clOrdId;
  const { dataSource: ordersDataSource, rows: orderRows } = useTradingRows(
    "parentOrders",
    {
      columns: ORDER_COLUMNS,
      filter: clOrdId ? `clOrdId = ${filterString(clOrdId)}` : NO_ORDER_FILTER,
      rowCount: 1,
    },
  );
  const order =
    clOrdId && orderRows[0]?.clOrdId === clOrdId ? orderRows[0] : undefined;

  const emit = useCallback(
    (event: TradingOrderEvent) => {
      const sourced = { source: ORDER_TICKET_SELECTION_SOURCE, ...event };
      onOrderEvent?.(sourced);
      if (notifyEnabled && notifications.provided)
        notifications.notify(sourced);
    },
    [notifications, notifyEnabled, onOrderEvent],
  );

  // Status changes of the submitted order after the RPC result.
  const lastStatus = useRef<{ clOrdId?: string; status?: unknown }>({});
  useEffect(() => {
    if (!order || submission.state !== "accepted") return;
    const previous = lastStatus.current;
    if (previous.clOrdId === order.clOrdId && previous.status === order.status)
      return;
    const first = previous.clOrdId !== order.clOrdId;
    lastStatus.current = {
      clOrdId: order.clOrdId as string,
      status: order.status,
    };
    // The RPC result already reported its status.
    if (first && order.status === submission.status) return;
    const kind = orderEventKindForStatus(order.status);
    const event = kind && orderEventFromParentOrder(order, kind);
    if (event) emit({ ...event, source: ORDER_TICKET_SELECTION_SOURCE });
  }, [order, submission, emit]);

  const validation = useMemo(
    () =>
      validateDraft(draft, instrument, accounts.length ? accounts : undefined),
    [draft, instrument, accounts],
  );
  const risk = useMemo(
    () =>
      previewRisk(draft, instrument, account, { usdPerPriceUnit, collarPct }),
    [draft, instrument, account, usdPerPriceUnit, collarPct],
  );

  const serverErrors: OrderDraftErrors =
    submission.state === "rejected"
      ? { [fieldForRejectReason(submission.reason)]: submission.text }
      : {};
  const visibleErrors: OrderDraftErrors = { ...serverErrors };
  for (const [field, message] of Object.entries(validation.errors)) {
    if (
      submitAttempted ||
      field === "form" ||
      touched[field as OrderDraftField]
    ) {
      visibleErrors[field as OrderDraftField] = message;
    }
  }

  const update = useCallback(
    (change: Partial<OrderDraft>) => {
      setDraft((current) => {
        const next = { ...current, ...change };
        if (
          change.strategy &&
          change.strategy !== current.strategy &&
          change.algoParams === undefined
        ) {
          next.algoParams = {};
        }
        // Stops are DMA only: the choice just made wins. An algo picked for
        // a stop turns it into the plain type (STOP → MARKET, STOP_LIMIT →
        // LIMIT); a stop type picked for an algo order switches it to DMA.
        if (change.ordType || change.strategy) {
          let notice: OrderTicketTypeNotice | undefined;
          if (!isStrategyAllowed(next.ordType, next.strategy)) {
            if (change.ordType === undefined) {
              const ordType = nonStopOrdType(next.ordType);
              notice = {
                field: "ordType",
                text: `Stops are DMA only: switched to ${ORD_TYPE_LABEL[ordType]}`,
              };
              next.ordType = ordType;
            } else {
              notice = {
                field: "strategy",
                text: "Stops are DMA only: switched to DMA",
              };
              next.strategy = AlgoStrategy.Dma;
              next.algoParams = {};
            }
          }
          setTypeNotice(notice);
        }
        // Prices the new type doesn't have are cleared.
        if (next.ordType !== current.ordType) {
          if (!isPricedOrdType(next.ordType) && change.price === undefined)
            next.price = "";
          if (!isStopOrdType(next.ordType) && change.stopPrice === undefined)
            next.stopPrice = "";
        }
        if (change.timeInForce) setTifNotice(undefined);
        else if (
          (change.ordType || change.strategy) &&
          !isTimeInForceAllowed(
            next.ordType,
            next.timeInForce,
            next.strategy,
            phaseRef.current,
          )
        ) {
          const valid = allowedTimesInForce(
            next.ordType,
            next.strategy,
            phaseRef.current,
          );
          const tif = valid.includes(TimeInForce.Day)
            ? TimeInForce.Day
            : (valid[0] ?? TimeInForce.Day);
          setTifNotice(
            `${current.timeInForce} isn't valid for ${
              change.strategy
                ? algoStrategyDefinition(next.strategy).name
                : next.ordType === OrdType.Market
                  ? "market orders"
                  : isStopOrdType(next.ordType)
                    ? "stop orders"
                    : "this order"
            }`,
          );
          next.timeInForce = tif;
        }
        if (change.account && rememberAccount) writeLastAccount(change.account);
        return next;
      });
      setTouched((current) => {
        const next = { ...current };
        for (const key of Object.keys(change)) {
          if (key === "algoParams") {
            for (const k of Object.keys(change.algoParams ?? {}))
              next[k as OrderDraftField] = true;
          } else next[key as OrderDraftField] = true;
        }
        return next;
      });
      setReviewing(false);
      setSubmission((current) =>
        current.state === "rejected" ? { state: "idle" } : current,
      );
    },
    [rememberAccount],
  );

  const selectInstrument = useCallback(
    (selected: SelectedInstrument) => {
      update({ ric: selected.ric, price: "", stopPrice: "" });
      // Clearing the old prices is not the user touching them: no error yet.
      setTouched((current) => ({
        ...current,
        price: false,
        stopPrice: false,
      }));
      if (publishSelection) {
        setSelectedInstrument(selected, ORDER_TICKET_SELECTION_SOURCE);
      }
    },
    [publishSelection, setSelectedInstrument, update],
  );

  const nudge = useCallback(
    (field: "price" | "stopPrice" | "quantity", steps: number) => {
      if (field === "price") {
        if (!isPricedOrdType(draft.ordType)) return;
        const price = nudgePrice(draft, instrument, steps);
        if (price !== undefined) update({ price });
      } else if (field === "stopPrice") {
        if (!isStopOrdType(draft.ordType)) return;
        const stopPrice = nudgeStopPrice(draft, instrument, steps);
        if (stopPrice !== undefined) update({ stopPrice });
      } else {
        update({ quantity: nudgeQuantity(draft.quantity, instrument, steps) });
      }
    },
    [draft, instrument, update],
  );

  const setPriceFrom = useCallback(
    (price: number | undefined) => {
      if (price === undefined || !isPricedOrdType(draft.ordType)) return;
      update({ price: formatPriceInput(price, instrument) });
    },
    [draft.ordType, instrument, update],
  );

  /** Set one strategy parameter (input text). */
  const setAlgoParam = useCallback(
    (key: AlgoParamKey, text: string) =>
      update({ algoParams: { ...draft.algoParams, [key]: text } }),
    [draft.algoParams, update],
  );

  /**
   * Replace shorthand in a field with what it means (`b+1` → 435.8,
   * `$250k` → 45,200), e.g. when the field is left.
   */
  const resolveShorthand = useCallback(
    (field: "price" | "stopPrice" | "quantity", text?: string) => {
      if (field === "price" || field === "stopPrice") {
        const input = text ?? draft[field];
        if (!isPriceShorthand(input)) return;
        const price = resolvePriceInput(input, instrument);
        if (price !== undefined && Number.isFinite(price))
          update({ [field]: formatPriceInput(price, instrument) });
      } else {
        const input = text ?? draft.quantity;
        if (!isValueInput(input)) return;
        const priced = isPricedOrdType(draft.ordType);
        const quantity = resolveQuantityInput(
          input,
          instrument,
          priced ? resolvePriceInput(draft.price, instrument) : risk.price,
          usdPerPriceUnit,
        );
        if (Number.isFinite(quantity)) update({ quantity: String(quantity) });
      }
    },
    [draft, instrument, risk.price, update, usdPerPriceUnit],
  );

  /**
   * Apply an order typed as one line in the instrument field (see
   * parseOrderLine). Fills the ticket; it does not send. Without a ric the
   * current instrument is kept.
   */
  const applyOrderLine = useCallback(
    (text: string) => {
      const { change } = parseOrderLine(text);
      if (Object.keys(change).length === 0) return false;
      if (change.ric && change.ric !== draft.ric) {
        if (change.price === undefined) change.price = "";
        if (change.stopPrice === undefined) change.stopPrice = "";
        if (publishSelection) {
          setSelectedInstrument(
            { ric: change.ric },
            ORDER_TICKET_SELECTION_SOURCE,
          );
        }
      }
      update(change);
      return true;
    },
    [draft.ric, publishSelection, setSelectedInstrument, update],
  );

  const reset = useCallback(() => {
    setDraft((current) => ({ ...baseline, account: current.account }));
    setTouched({});
    setSubmitAttempted(false);
    setSubmission({ state: "idle" });
    setTifNotice(undefined);
    setTypeNotice(undefined);
    setReviewing(false);
  }, [baseline]);

  const dirty =
    submission.state !== "idle" ||
    (Object.keys(baseline) as (keyof OrderDraft)[]).some(
      (key) => key !== "account" && baseline[key] !== draft[key],
    );

  const review = useMemo(() => reviewReasons(risk), [risk]);

  const submit = useCallback(
    async ({ confirmed = false } = {}) => {
      if (submission.state === "pending") return;
      setSubmitAttempted(true);
      // Blocked while the connection is down (also F9 / Ctrl+Enter).
      if (blockedReason) return;
      const { params } = validation;
      if (!params) return;
      if (review.length > 0 && !confirmed) {
        setReviewing(true);
        return;
      }
      setReviewing(false);
      const id = newClOrdId(clOrdIdPrefix);
      const request = { ...params, clOrdId: id };
      const base: TradingOrderEvent = {
        kind: "submitted",
        clOrdId: id,
        ric: request.ric,
        side: request.side,
        quantity: request.quantity,
        price: request.price,
        account: request.account,
        currency: instrument?.currency,
      };
      lastStatus.current = {};
      setSubmission({ state: "pending", clOrdId: id });
      if (rememberAccount) writeLastAccount(request.account);
      try {
        // The ticket's parentOrders data source is filtered on this clOrdId
        // so the live order shows; the RPC only needs it to be subscribed.
        ordersDataSource.filter = { filter: `clOrdId = ${filterString(id)}` };
        const result = await sendTradingRpc(
          ordersDataSource,
          "createOrder",
          request,
          { connectionState },
        );
        setSubmission({
          state: "accepted",
          clOrdId: id,
          orderId: result.orderId,
          status: result.status,
        });
        // Ready for the next order: keep instrument, side, price and
        // strategy; clear the size.
        setDraft((current) => ({ ...current, quantity: "" }));
        setTouched({});
        setSubmitAttempted(false);
        const kind = orderEventKindForStatus(result.status) ?? "ack";
        emit({ ...base, kind, orderId: result.orderId, status: result.status });
      } catch (error) {
        const { reason, text } =
          error instanceof TradingRpcError
            ? error
            : { reason: "INTERNAL_ERROR", text: String(error) };
        setSubmission({ state: "rejected", clOrdId: id, reason, text });
        emit({
          ...base,
          kind: "reject",
          reason,
          text,
          status: OrdStatus.Rejected,
        });
      }
    },
    [
      blockedReason,
      clOrdIdPrefix,
      connectionState,
      emit,
      instrument?.currency,
      ordersDataSource,
      rememberAccount,
      review.length,
      submission.state,
      validation,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const root = event.currentTarget;
      const target = event.target as HTMLElement;
      const inPicker = !!target.closest?.("[data-instrument-picker]");
      const expanded = target.getAttribute?.("aria-expanded") === "true";
      const field = target.dataset?.orderTicketField;
      const { key } = event;
      const resolveCurrent = () => {
        // The live text: with fast typing the last render can be behind.
        if (field === "price" || field === "stopPrice" || field === "quantity")
          resolveShorthand(field, (target as HTMLInputElement).value);
      };
      if (
        key === "F9" ||
        (key === "Enter" && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        resolveCurrent();
        void submit();
        return;
      }
      if (key === "Escape") {
        if (expanded) return;
        event.preventDefault();
        if (reviewing) setReviewing(false);
        else if (dirty) reset();
        else onClose?.();
        return;
      }
      if (reviewing) {
        if (key === "Enter" && !target.closest?.("[data-review-back]")) {
          event.preventDefault();
          void submit({ confirmed: true });
        }
        return;
      }
      // Alt / Option shortcuts work from any field (event.code: Option on
      // macOS changes event.key).
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const code = event.code;
        const act = (fn: () => void) => {
          event.preventDefault();
          fn();
        };
        if (code === "KeyB") return act(() => update({ side: "BUY" }));
        if (code === "KeyS") return act(() => update({ side: "SELL" }));
        if (code === "KeyL")
          return act(() => update({ ordType: OrdType.Limit }));
        if (code === "KeyM")
          return act(() => update({ ordType: OrdType.Market }));
        // P for stoP (S is Sell); Shift for a stop limit.
        if (code === "KeyP")
          return act(() =>
            update({
              ordType: event.shiftKey ? OrdType.StopLimit : OrdType.Stop,
            }),
          );
        if (code === "KeyT")
          return act(() => {
            const valid = allowedTimesInForce(
              draft.ordType,
              draft.strategy,
              instrument?.phase,
            );
            const next =
              valid[(valid.indexOf(draft.timeInForce) + 1) % valid.length];
            if (next) update({ timeInForce: next });
          });
        if (code === "KeyE")
          return act(() =>
            root
              .querySelector<HTMLElement>(
                '[data-order-ticket-field="strategy"]',
              )
              ?.focus(),
          );
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      // Enter accepts a field and moves to the next one.
      if (
        key === "Enter" &&
        field &&
        field !== "submit" &&
        field !== "strategy" &&
        !expanded
      ) {
        event.preventDefault();
        resolveCurrent();
        focusTicketField(nextField(root, target));
        return;
      }
      if (
        (key === "b" || key === "B" || key === "s" || key === "S") &&
        !inPicker
      ) {
        // In text fields only quantity, where letters other than k / m are
        // not valid input (price takes b / a / m shorthand).
        if (isTextEntry(target) && field !== "quantity") return;
        event.preventDefault();
        update({ side: key.toLowerCase() === "b" ? "BUY" : "SELL" });
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        const steps = (key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1);
        if (
          field === "price" ||
          field === "stopPrice" ||
          field === "quantity"
        ) {
          event.preventDefault();
          nudge(field, steps);
        } else if (field?.startsWith("param:")) {
          const k = field.slice(6) as AlgoParamKey;
          const param = algoStrategyDefinition(draft.strategy).params.find(
            (p) => p.key === k,
          );
          if (!param) return;
          event.preventDefault();
          const next = stepAlgoParam(param, draft.algoParams[k], steps);
          if (next !== undefined) setAlgoParam(k, next);
        }
      }
    },
    [
      dirty,
      draft,
      instrument?.phase,
      nudge,
      onClose,
      reset,
      resolveShorthand,
      reviewing,
      setAlgoParam,
      submit,
      update,
    ],
  );

  return {
    draft,
    update,
    selectInstrument,
    nudge,
    setPriceFrom,
    setAlgoParam,
    resolveShorthand,
    applyOrderLine,
    /** Why the TIF was just changed, if it was. */
    tifNotice,
    /** Why the order type or strategy was just changed (stops are DMA only). */
    typeNotice,
    /** Warnings that send the order through Review first. */
    review,
    /** The Review step is open. */
    reviewing,
    closeReview: () => setReviewing(false),
    reset,
    submit,
    dirty,
    instrument,
    accounts,
    account,
    /** The account's position in the instrument (signed), if known. */
    position,
    validation,
    errors: visibleErrors,
    risk,
    submission,
    /** The trading server connection state. */
    connectionState,
    /** Why submission is blocked (not connected), else undefined. */
    blockedReason,
    /** The submitted order's live parentOrders row. */
    order,
    handleKeyDown,
  };
};

export type OrderTicketState = ReturnType<typeof useOrderTicket>;
