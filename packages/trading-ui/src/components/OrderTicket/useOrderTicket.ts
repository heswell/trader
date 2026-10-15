import {
  isPricedOrdType,
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
  EMPTY_DRAFT,
  fieldForRejectReason,
  formatPriceInput,
  isTimeInForceAllowed,
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
  quantity?: number;
  ordType?: OrdType;
  timeInForce?: TimeInForce;
  account?: string;
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
  "refPrice",
  "bid",
  "ask",
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
];

const NO_ORDER_FILTER = 'clOrdId = "-"';

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
    (prefill?.price !== undefined ? OrdType.Limit : EMPTY_DRAFT.ordType);
  const timeInForce = prefill?.timeInForce ?? EMPTY_DRAFT.timeInForce;
  return {
    ric: prefill?.ric ?? prefill?.instrument?.ric ?? fallback.ric,
    side: prefill?.side ?? EMPTY_DRAFT.side,
    ordType,
    timeInForce: isTimeInForceAllowed(ordType, timeInForce)
      ? timeInForce
      : TimeInForce.Day,
    quantity: prefill?.quantity !== undefined ? String(prefill.quantity) : "",
    price:
      prefill?.price !== undefined && isPricedOrdType(ordType)
        ? formatPriceInput(prefill.price, prefill.instrument)
        : "",
    account: prefill?.account ?? fallback.account,
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
        : { ...current, ric: selectedInstrument.ric, price: "" },
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
          change.ordType &&
          !isTimeInForceAllowed(next.ordType, next.timeInForce)
        ) {
          next.timeInForce = TimeInForce.Day;
        }
        if (change.ordType === OrdType.Market) next.price = "";
        if (change.account && rememberAccount) writeLastAccount(change.account);
        return next;
      });
      setTouched((current) => {
        const next = { ...current };
        for (const key of Object.keys(change))
          next[key as OrderDraftField] = true;
        return next;
      });
      setSubmission((current) =>
        current.state === "rejected" ? { state: "idle" } : current,
      );
    },
    [rememberAccount],
  );

  const selectInstrument = useCallback(
    (selected: SelectedInstrument) => {
      update({ ric: selected.ric, price: "" });
      if (publishSelection) {
        setSelectedInstrument(selected, ORDER_TICKET_SELECTION_SOURCE);
      }
    },
    [publishSelection, setSelectedInstrument, update],
  );

  const nudge = useCallback(
    (field: "price" | "quantity", steps: number) => {
      if (field === "price") {
        if (!isPricedOrdType(draft.ordType)) return;
        const price = nudgePrice(draft, instrument, steps);
        if (price !== undefined) update({ price });
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

  const reset = useCallback(() => {
    setDraft((current) => ({ ...baseline, account: current.account }));
    setTouched({});
    setSubmitAttempted(false);
    setSubmission({ state: "idle" });
  }, [baseline]);

  const dirty =
    submission.state !== "idle" ||
    (Object.keys(baseline) as (keyof OrderDraft)[]).some(
      (key) => key !== "account" && baseline[key] !== draft[key],
    );

  const submit = useCallback(async () => {
    if (submission.state === "pending") return;
    setSubmitAttempted(true);
    // Blocked while the connection is down (also F9 / Ctrl+Enter).
    if (blockedReason) return;
    const { params } = validation;
    if (!params) return;
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
  }, [
    blockedReason,
    clOrdIdPrefix,
    connectionState,
    emit,
    instrument?.currency,
    ordersDataSource,
    rememberAccount,
    submission.state,
    validation,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      const inPicker = !!target.closest?.("[data-instrument-picker]");
      const expanded = target.getAttribute?.("aria-expanded") === "true";
      const { key } = event;
      if (
        key === "F9" ||
        (key === "Enter" && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        void submit();
        return;
      }
      if (key === "Escape") {
        if (expanded) return;
        event.preventDefault();
        if (dirty) reset();
        else onClose?.();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const field = target.dataset?.orderTicketField;
      if (
        (key === "b" || key === "B" || key === "s" || key === "S") &&
        !inPicker
      ) {
        // In text fields only the quantity / price inputs, where letters
        // other than the k / m suffixes are not valid input anyway.
        if (isTextEntry(target) && field !== "price" && field !== "quantity")
          return;
        event.preventDefault();
        update({ side: key.toLowerCase() === "b" ? "BUY" : "SELL" });
        return;
      }
      if (
        (key === "ArrowUp" || key === "ArrowDown") &&
        (field === "price" || field === "quantity")
      ) {
        event.preventDefault();
        const steps = (key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1);
        nudge(field, steps);
      }
    },
    [dirty, nudge, onClose, reset, submit, update],
  );

  return {
    draft,
    update,
    selectInstrument,
    nudge,
    setPriceFrom,
    reset,
    submit,
    dirty,
    instrument,
    accounts,
    account,
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
