import {
  type AlgoParamDefinition,
  AlgoStrategy,
  algoStrategyDefinition,
  decodeEntryMessages,
  EntryMessageLevel,
  entryReviewMessages,
  hasEntryErrors,
  isPricedOrdType,
  isStopOrdType,
  OrdStatus,
  OrdType,
  type RpcRequestParams,
  type Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import type { VuuRowDataItemType } from "@vuu-ui/vuu-protocol-types";
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
import {
  sendTradingRpc,
  TradingRpcError,
  withRpcTimeout,
} from "../../data/tradingRpc";
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
  isValueInput,
  nonStopOrdType,
  ORD_TYPE_LABEL,
  parseAlgoParam,
  parseOrderLine,
  parseTimeInput,
  resolvePriceInput,
  resolveQuantityInput,
  newClOrdId,
  nudgePrice,
  nudgeStopPrice,
  nudgeQuantity,
  type OrderDraft,
  type OrderDraftErrors,
  type OrderDraftField,
  type OrderTicketAccount,
  type OrderTicketInstrument,
  previewRisk,
  type RiskPreviewOptions,
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

/** A reason the order goes through Review before it is sent. */
export interface OrderTicketReviewReason {
  code: string;
  text: string;
}

export type OrderTicketSubmission =
  | { state: "idle" }
  | { state: "pending"; clOrdId: string }
  | {
      state: "accepted";
      clOrdId: string;
      orderId: string;
      /** Status from the sendOrder result (live status: `order`). */
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

/**
 * The draft fields of an orderEntry row. Choices (side, type ...) are
 * committed as they are made; typed text (quantity, prices, strategy
 * parameters) when the field is left or Enter is pressed.
 */
const CHOICE_FIELDS = [
  "ric",
  "side",
  "ordType",
  "timeInForce",
  "account",
  "strategy",
] as const;
const TEXT_FIELDS = ["quantity", "price", "stopPrice"] as const;
const ALGO_FIELDS: readonly AlgoParamKey[] = [
  "durationMins",
  "endTime",
  "participationPct",
];
type EntryField =
  | (typeof CHOICE_FIELDS)[number]
  | (typeof TEXT_FIELDS)[number]
  | AlgoParamKey;
const ENTRY_FIELDS: readonly EntryField[] = [
  ...CHOICE_FIELDS,
  ...TEXT_FIELDS,
  ...ALGO_FIELDS,
];
const isEntryField = (field: string): field is EntryField =>
  (ENTRY_FIELDS as readonly string[]).includes(field);
const isChoiceField = (field: EntryField) =>
  (CHOICE_FIELDS as readonly string[]).includes(field);

type EntryValue = string | number;
type EntryValues = Partial<Record<EntryField, EntryValue>>;

/** The orderEntryPrices columns the ticket reads. */
const ENTRY_COLUMNS = [
  ...new Set([
    "entryId",
    ...ENTRY_FIELDS,
    ...INSTRUMENT_PRICE_COLUMNS,
    "clOrdId",
    "orderId",
    "lastUpdate",
    "vuuMsg",
  ]),
];

const NO_ENTRY_FILTER = 'entryId = "-"';
const NO_ORDER_FILTER = 'clOrdId = "-"';
const NO_POSITION_FILTER = 'ric = "-"';
/** How long sending waits for the row to show the last edits (ms). */
const ROW_WAIT_MS = 500;

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

type EntryValueResult =
  | { value: EntryValue; error?: undefined }
  | { value?: undefined; error: string };

/**
 * The orderEntry column value of a draft field (empty text is 0 / ""), or
 * why the text can't be sent (not a number, shorthand without a price).
 */
const entryValueOf = (
  draft: OrderDraft,
  field: EntryField,
  instrument: OrderTicketInstrument | undefined,
  options: RiskPreviewOptions,
): EntryValueResult => {
  switch (field) {
    case "ric":
      return { value: draft.ric ?? "" };
    case "account":
      return { value: draft.account ?? "" };
    case "strategy":
      return { value: draft.strategy ?? AlgoStrategy.Dma };
    case "side":
    case "ordType":
    case "timeInForce":
      return { value: draft[field] };
    case "quantity": {
      const text = draft.quantity.trim();
      if (text === "") return { value: 0 };
      const quantity = resolveQuantityInput(
        text,
        instrument,
        previewRisk(draft, instrument, undefined, options).price,
        options.usdPerPriceUnit,
      );
      return Number.isFinite(quantity)
        ? { value: quantity }
        : {
            error: isValueInput(text)
              ? "Can't convert a value without a price"
              : "Quantity must be a number, 10k or $250k",
          };
    }
    case "price":
    case "stopPrice": {
      const text = draft[field].trim();
      if (text === "") return { value: 0 };
      const price = resolvePriceInput(text, instrument);
      return price !== undefined && Number.isFinite(price)
        ? { value: price }
        : {
            error: isPriceShorthand(text)
              ? "No bid / ask to price from"
              : `${field === "price" ? "Price" : "Stop price"} must be a number, or b / a / m`,
          };
    }
    default: {
      const empty = field === "endTime" ? "" : 0;
      const text = draft.algoParams[field]?.trim() ?? "";
      const param = algoStrategyDefinition(draft.strategy).params.find(
        (p) => p.key === field,
      );
      if (text === "" || !param) return { value: empty };
      const { value, error } = parseAlgoParam(param, text);
      return value !== undefined && !error
        ? { value }
        : { error: error ?? `Check ${param.label.toLowerCase()}` };
    }
  }
};

/** The draft with a field set from its orderEntry column value. */
const withEntryValue = (
  draft: OrderDraft,
  field: EntryField,
  value: EntryValue,
  instrument: OrderTicketInstrument | undefined,
): OrderDraft => {
  const empty = value === 0 || value === "";
  switch (field) {
    case "ric":
    case "account":
      return { ...draft, [field]: empty ? undefined : String(value) };
    case "strategy":
      return {
        ...draft,
        strategy: (value || AlgoStrategy.Dma) as AlgoStrategy,
      };
    case "side":
    case "ordType":
    case "timeInForce":
      return { ...draft, [field]: value };
    case "quantity":
      return { ...draft, quantity: empty ? "" : String(value) };
    case "price":
    case "stopPrice":
      return {
        ...draft,
        [field]: empty ? "" : formatPriceInput(Number(value), instrument),
      };
    default: {
      const { [field]: _, ...algoParams } = draft.algoParams;
      return {
        ...draft,
        algoParams: empty
          ? algoParams
          : { ...algoParams, [field]: String(value) },
      };
    }
  }
};

/** The draft fields a change sets (strategy parameters that differ). */
const fieldsOf = (
  change: Partial<OrderDraft>,
  current: OrderDraft,
): EntryField[] => {
  const fields: EntryField[] = [];
  for (const key of Object.keys(change)) {
    if (key === "algoParams") {
      const params = change.algoParams ?? {};
      for (const k of ALGO_FIELDS) {
        if ((params[k] ?? "") !== (current.algoParams[k] ?? "")) fields.push(k);
      }
    } else if (isEntryField(key)) fields.push(key);
  }
  return fields;
};

/** A draft field's value as text (for spotting what changed). */
const draftText = (draft: OrderDraft, field: EntryField): string =>
  (ALGO_FIELDS as readonly string[]).includes(field)
    ? (draft.algoParams[field as AlgoParamKey] ?? "")
    : String(draft[field as keyof OrderDraft] ?? "");

/**
 * A change with the knock-on rules the OMS applies to the row (shared from
 * trading-schemas), applied here too so the next key works on the result:
 * a new strategy clears its parameters, stops are DMA only (the choice
 * just made wins), an order type without a price clears it, and a TIF the
 * new type or strategy can't take falls back to DAY. The notices are
 * `false` when the change leaves them as they were.
 */
export const withKnockOns = (
  current: OrderDraft,
  change: Partial<OrderDraft>,
  phase?: string,
): {
  draft: OrderDraft;
  typeNotice: OrderTicketTypeNotice | undefined | false;
  tifNotice: string | undefined | false;
} => {
  const next = { ...current, ...change };
  if (
    change.strategy &&
    change.strategy !== current.strategy &&
    change.algoParams === undefined
  ) {
    next.algoParams = {};
  }
  let typeNotice: OrderTicketTypeNotice | undefined | false = false;
  if (change.ordType || change.strategy) {
    typeNotice = undefined;
    if (!isStrategyAllowed(next.ordType, next.strategy)) {
      if (change.ordType === undefined) {
        next.ordType = nonStopOrdType(next.ordType);
        typeNotice = {
          field: "ordType",
          text: `Stops are DMA only: switched to ${ORD_TYPE_LABEL[next.ordType]}`,
        };
      } else {
        next.strategy = AlgoStrategy.Dma;
        next.algoParams = {};
        typeNotice = {
          field: "strategy",
          text: "Stops are DMA only: switched to DMA",
        };
      }
    }
  }
  if (next.ordType !== current.ordType) {
    if (!isPricedOrdType(next.ordType) && change.price === undefined)
      next.price = "";
    if (!isStopOrdType(next.ordType) && change.stopPrice === undefined)
      next.stopPrice = "";
  }
  let tifNotice: string | undefined | false = false;
  if (change.timeInForce) tifNotice = undefined;
  else if (
    (change.ordType || change.strategy) &&
    !isTimeInForceAllowed(next.ordType, next.timeInForce, next.strategy, phase)
  ) {
    const valid = allowedTimesInForce(next.ordType, next.strategy, phase);
    tifNotice = `${current.timeInForce} isn't valid for ${
      change.strategy
        ? algoStrategyDefinition(next.strategy).name
        : next.ordType === OrdType.Market
          ? "market orders"
          : isStopOrdType(next.ordType)
            ? "stop orders"
            : "this order"
    }`;
    next.timeInForce = valid.includes(TimeInForce.Day)
      ? TimeInForce.Day
      : (valid[0] ?? TimeInForce.Day);
  }
  return { draft: next, typeNotice, tifNotice };
};

const isRpcErrorResult = (
  result: unknown,
): result is { type: "ERROR_RESULT"; errorMessage: string } =>
  typeof result === "object" &&
  result !== null &&
  (result as { type?: unknown }).type === "ERROR_RESULT";

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
 *
 * The ticket is a form over one row of the OMS `orderEntry` table, read
 * through the `orderEntryPrices` join (so the row carries the instrument's
 * static data and live prices). The row is opened with openOrderEntry;
 * fields are written with editCell when committed; the OMS validates the
 * row and reports errors, warnings and notices in its vuuMsg column
 * (decodeEntryMessages); sendOrder turns it into an order.
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
  const connectionStateRef = useRef(connectionState);
  connectionStateRef.current = connectionState;
  const blockedReason = connectionBlockedReason(connectionState);
  const riskOptions = useMemo(
    () => ({ usdPerPriceUnit, collarPct }),
    [usdPerPriceUnit, collarPct],
  );
  const riskOptionsRef = useRef<RiskPreviewOptions>(riskOptions);
  riskOptionsRef.current = riskOptions;

  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed per prefill only
  const initialDraft = useMemo(
    () =>
      draftFromPrefill(prefill, {
        ric: followSelection ? selectedInstrument?.ric : undefined,
      }),
    [prefill],
  );
  /** The form's text, ahead of the row while a field is being typed in. */
  const [draft, setDraftState] = useState<OrderDraft>(initialDraft);
  const draftRef = useRef(draft);
  const setDraft = useCallback((next: OrderDraft) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const [baseline, setBaseline] = useState<OrderDraft>(initialDraft);
  const [touched, setTouched] = useState<
    Partial<Record<OrderDraftField, boolean>>
  >({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submission, setSubmission] = useState<OrderTicketSubmission>({
    state: "idle",
  });
  /** The Review step is open (warnings that need a second look). */
  const [reviewing, setReviewing] = useState(false);
  /** Text that can't be sent (not a number ...) or an edit the OMS refused. */
  const [localErrors, setLocalErrorsState] = useState<OrderDraftErrors>({});
  const localErrorsRef = useRef(localErrors);
  const setLocalErrors = useCallback(
    (fn: (current: OrderDraftErrors) => OrderDraftErrors) => {
      localErrorsRef.current = fn(localErrorsRef.current);
      setLocalErrorsState(localErrorsRef.current);
    },
    [],
  );
  /** Fields typed in and not yet committed. */
  const editingRef = useRef(new Set<EntryField>());
  /**
   * Fields committed and not yet shown by the row: the row's messages about
   * them are about the old value, so they are not shown until it catches
   * up (the edit answered and a row update since, or the value arrived).
   */
  const awaitingRef = useRef(
    new Map<EntryField, { seq: number; value: EntryValue; acked: boolean }>(),
  );
  const editSeqRef = useRef(0);
  const [, setAwaitVersion] = useState(0);

  // ------------------------------------------------------- the orderEntry row
  const [ticketId] = useState(() => newClOrdId("TKT").slice(0, 48));
  const [entryId, setEntryId] = useState<string>();
  const entryIdRef = useRef<string | undefined>(undefined);
  const {
    dataSource: entryDataSource,
    rows: entryRows,
    loaded: entryLoaded,
  } = useTradingRows("orderEntryPrices", {
    columns: ENTRY_COLUMNS,
    filter: entryId ? `entryId = ${filterString(entryId)}` : NO_ENTRY_FILTER,
    rowCount: 1,
  });
  const row =
    entryId && entryRows[0]?.entryId === entryId ? entryRows[0] : undefined;
  const rowRef = useRef(row);
  rowRef.current = row;

  // Static data and live prices of the draft's instrument (from the row).
  const instrument = useMemo(
    () => (row?.ric && row.ric === draft.ric ? toInstrument(row) : undefined),
    [row, draft.ric],
  );
  const instrumentRef = useRef(instrument);
  instrumentRef.current = instrument;

  const vuuMsg = row?.vuuMsg as string | undefined;
  const messages = useMemo(() => decodeEntryMessages(vuuMsg), [vuuMsg]);

  /** Values committed before the row was opened. */
  const pendingRef = useRef<EntryValues>({});
  /** Edits sent and not yet answered. */
  const inflightRef = useRef(new Set<Promise<unknown>>());
  const track = useCallback(<T>(request: Promise<T>) => {
    inflightRef.current.add(request);
    const done = () => inflightRef.current.delete(request);
    request.then(done, done);
    return request;
  }, []);

  /** Write values to the row: editCell for one, updateOrderEntry for more. */
  const sendValues = useCallback(
    (values: EntryValues) => {
      const fields = Object.keys(values) as EntryField[];
      if (fields.length === 0) return;
      const seq = ++editSeqRef.current;
      const awaiting = awaitingRef.current;
      for (const field of fields) {
        awaiting.set(field, {
          seq,
          value: values[field] as EntryValue,
          acked: false,
        });
      }
      const settle = (acked: boolean) => {
        for (const field of fields) {
          const entry = awaiting.get(field);
          if (entry?.seq !== seq) continue;
          if (acked) entry.acked = true;
          else awaiting.delete(field);
        }
      };
      const id = entryIdRef.current;
      if (!id) {
        Object.assign(pendingRef.current, values);
        return;
      }
      const [only] = fields;
      const editCell = entryDataSource.editCell?.bind(entryDataSource);
      const request: Promise<unknown> =
        fields.length === 1 &&
        editCell &&
        connectionStateRef.current === "connected"
          ? withRpcTimeout(
              Promise.resolve(
                editCell(id, only, values[only] as VuuRowDataItemType),
              ).then((result: unknown) => {
                if (isRpcErrorResult(result))
                  throw new TradingRpcError(
                    "updateOrderEntry",
                    result.errorMessage,
                  );
              }),
              "updateOrderEntry",
            )
          : sendTradingRpc(
              entryDataSource,
              "updateOrderEntry",
              {
                entryId: id,
                ...values,
              } as RpcRequestParams<"updateOrderEntry">,
              { connectionState: connectionStateRef.current },
            );
      track(request).then(
        () => settle(true),
        () => settle(false),
      );
      request.catch((error: unknown) => {
        const text =
          error instanceof TradingRpcError ? error.text : String(error);
        setLocalErrors((current) => {
          const next = { ...current };
          for (const field of fields) next[field] = text;
          return next;
        });
      });
    },
    [entryDataSource, setLocalErrors, track],
  );

  /** Commit fields: send the draft's values of them to the row. */
  const commitFields = useCallback(
    (fields: readonly EntryField[]) => {
      if (fields.length === 0) return;
      const current = draftRef.current;
      const values: EntryValues = {};
      const errors: OrderDraftErrors = {};
      for (const field of fields) {
        editingRef.current.delete(field);
        const { value, error } = entryValueOf(
          current,
          field,
          instrumentRef.current,
          riskOptionsRef.current,
        );
        if (error !== undefined) errors[field] = error;
        else values[field] = value;
      }
      setLocalErrors((current) => {
        const next = { ...current };
        for (const field of fields) delete next[field];
        return { ...next, ...errors };
      });
      sendValues(values);
    },
    [sendValues, setLocalErrors],
  );

  // Open the row once subscribed (again after a reconnect: the server may
  // have restarted), with the whole draft.
  const openedRef = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") {
      openedRef.current = false;
      return;
    }
    if (!entryLoaded || openedRef.current) return;
    openedRef.current = true;
    const current = draftRef.current;
    const values: EntryValues = {};
    for (const field of ENTRY_FIELDS) {
      const { value } = entryValueOf(
        current,
        field,
        instrumentRef.current,
        riskOptionsRef.current,
      );
      if (value !== undefined) values[field] = value;
    }
    if (!current.account && rememberAccount) {
      const remembered = readLastAccount();
      if (remembered) values.account = remembered;
    }
    editingRef.current.clear();
    pendingRef.current = {};
    track(
      sendTradingRpc(
        entryDataSource,
        "openOrderEntry",
        { ticketId, ...values } as RpcRequestParams<"openOrderEntry">,
        { connectionState },
      ),
    ).then(
      ({ entryId: id }) => {
        entryIdRef.current = id;
        setEntryId(id);
        const pending = pendingRef.current;
        pendingRef.current = {};
        sendValues(pending);
      },
      () => {
        openedRef.current = false;
      },
    );
  }, [
    connectionState,
    entryDataSource,
    entryLoaded,
    rememberAccount,
    sendValues,
    ticketId,
    track,
  ]);

  // The row goes with the ticket.
  useEffect(
    () => () => {
      const id = entryIdRef.current;
      openedRef.current = false;
      if (id) {
        sendTradingRpc(entryDataSource, "closeOrderEntry", {
          entryId: id,
        }).catch(() => {
          // the OMS drops idle rows anyway
        });
      }
    },
    [entryDataSource],
  );

  // Changes the OMS made to the row (the knock-on rules, a sent order's
  // quantity) are copied into the draft, except in fields being typed in.
  const seenRef = useRef<EntryValues>({});
  const rowWaitersRef = useRef<(() => void)[]>([]);
  useEffect(() => {
    if (!row) return;
    const awaiting = awaitingRef.current;
    if (awaiting.size > 0) {
      let caughtUp = false;
      for (const [field, { value, acked }] of awaiting) {
        if (acked || row[field] === value) {
          awaiting.delete(field);
          caughtUp = true;
        }
      }
      // Render again: this render hid their messages.
      if (caughtUp) setAwaitVersion((v) => v + 1);
    }
    const waiters = rowWaitersRef.current;
    rowWaitersRef.current = [];
    for (const resolve of waiters) resolve();
    const seen = seenRef.current;
    const rowInstrument = toInstrument(row);
    const current = draftRef.current;
    let next = current;
    for (const field of ENTRY_FIELDS) {
      const value = row[field] as EntryValue | null | undefined;
      if (value === undefined || value === null || seen[field] === value)
        continue;
      seen[field] = value;
      if (editingRef.current.has(field)) continue;
      const local = entryValueOf(
        next,
        field,
        rowInstrument,
        riskOptionsRef.current,
      );
      if (local.value === value) continue;
      next = withEntryValue(next, field, value, rowInstrument);
    }
    if (next !== current) setDraft(next);
  }, [row, setDraft]);
  /** Resolves on the next row update (or after `ms`). */
  const nextRow = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        rowWaitersRef.current.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    [],
  );

  // A new prefill replaces the draft.
  const prefillRef = useRef(prefill);
  useEffect(() => {
    if (prefillRef.current === prefill) return;
    prefillRef.current = prefill;
    const current = draftRef.current;
    const next = draftFromPrefill(prefill, {
      ric: current.ric,
      account: current.account,
    });
    setDraft(next);
    setBaseline(next);
    setTouched({});
    setSubmitAttempted(false);
    setSubmission({ state: "idle" });
    setLocalErrors(() => ({}));
    commitFields(ENTRY_FIELDS);
  }, [prefill, commitFields, setDraft, setLocalErrors]);

  // Follow selections made elsewhere.
  useEffect(() => {
    if (
      !followSelection ||
      !selectedInstrument ||
      selectionSource === ORDER_TICKET_SELECTION_SOURCE
    ) {
      return;
    }
    const current = draftRef.current;
    if (current.ric === selectedInstrument.ric) return;
    setDraft({
      ...current,
      ric: selectedInstrument.ric,
      price: "",
      stopPrice: "",
    });
    commitFields(["ric", "price", "stopPrice"]);
  }, [
    followSelection,
    selectedInstrument,
    selectionSource,
    commitFields,
    setDraft,
  ]);

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
    const current = draftRef.current;
    if (current.account && accounts.some((a) => a.account === current.account))
      return;
    const remembered = rememberAccount ? readLastAccount() : undefined;
    const account =
      (remembered && accounts.find((a) => a.account === remembered)?.account) ??
      accounts[0].account;
    setBaseline((b) => (b.account ? b : { ...b, account }));
    setDraft({ ...current, account });
    commitFields(["account"]);
  }, [accounts, rememberAccount, commitFields, setDraft]);
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

  // The submitted order.
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

  /** Indicative notional, limit usage and price checks, for display. */
  const risk = useMemo(
    () => previewRisk(draft, instrument, account, riskOptions),
    [draft, instrument, account, riskOptions],
  );

  // Errors: the OMS's (vuuMsg) once a field is touched or a send was tried,
  // not while it is being typed in; text that couldn't be sent, always.
  const visibleErrors: OrderDraftErrors =
    submission.state === "rejected"
      ? { [fieldForRejectReason(submission.reason)]: submission.text }
      : {};
  for (const { level, field, text } of messages) {
    if (level !== EntryMessageLevel.Error) continue;
    const key = field as OrderDraftField | "form";
    if (
      isEntryField(key) &&
      (editingRef.current.has(key) || awaitingRef.current.has(key))
    )
      continue;
    if (
      (submitAttempted || key === "form" || touched[key as OrderDraftField]) &&
      visibleErrors[key] === undefined
    ) {
      visibleErrors[key] = text;
    }
  }
  Object.assign(visibleErrors, localErrors);

  // Why the ticket just changed the TIF, order type or strategy: set as
  // the rules are applied here, else what the OMS said it did.
  const [localTifNotice, setTifNotice] = useState<string | undefined>();
  const [localTypeNotice, setTypeNotice] = useState<
    OrderTicketTypeNotice | undefined
  >();
  const tifNotice =
    localTifNotice ??
    messages.find(
      (m) => m.level === EntryMessageLevel.Info && m.code === "TIF_CHANGED",
    )?.text;
  const serverTypeNotice = useMemo((): OrderTicketTypeNotice | undefined => {
    const notice = messages.find(
      (m) =>
        m.level === EntryMessageLevel.Info &&
        (m.code === "TYPE_CHANGED" || m.code === "STRATEGY_CHANGED"),
    );
    return notice
      ? { field: notice.field as "ordType" | "strategy", text: notice.text }
      : undefined;
  }, [messages]);
  const typeNotice = localTypeNotice ?? serverTypeNotice;
  const review = useMemo(
    (): OrderTicketReviewReason[] =>
      entryReviewMessages(messages).map(({ code, text }) => ({ code, text })),
    [messages],
  );

  /**
   * Change the draft. Choices are committed now; typed text when `commit`
   * (a nudge, a click) or when the field is left (resolveShorthand /
   * commit).
   */
  const apply = useCallback(
    (change: Partial<OrderDraft>, commit: boolean) => {
      const current = draftRef.current;
      const typed = fieldsOf(change, current);
      const next = withKnockOns(current, change, instrumentRef.current?.phase);
      setDraft(next.draft);
      if (next.typeNotice !== false) setTypeNotice(next.typeNotice);
      if (next.tifNotice !== false) setTifNotice(next.tifNotice);
      // Typed text waits for the field to be left; choices, and whatever
      // the rules changed, go now (together, as one updateOrderEntry).
      const now: EntryField[] = [];
      for (const field of ENTRY_FIELDS) {
        if (typed.includes(field) && !commit && !isChoiceField(field)) {
          editingRef.current.add(field);
        } else if (
          typed.includes(field) ||
          draftText(next.draft, field) !== draftText(current, field)
        ) {
          now.push(field);
        }
      }
      commitFields(now);
      if (change.account && rememberAccount) writeLastAccount(change.account);
      setTouched((current) => {
        const touchedNow = { ...current };
        for (const field of typed) touchedNow[field] = true;
        return touchedNow;
      });
      setReviewing(false);
      setSubmission((current) =>
        current.state === "rejected" ? { state: "idle" } : current,
      );
    },
    [commitFields, rememberAccount, setDraft],
  );

  /** Change the draft as typed: text fields are committed when left. */
  const update = useCallback(
    (change: Partial<OrderDraft>) => apply(change, false),
    [apply],
  );

  /** Commit a field typed in (when it is left). */
  const commit = useCallback(
    (field: OrderDraftField) => {
      if (isEntryField(field) && editingRef.current.has(field))
        commitFields([field]);
    },
    [commitFields],
  );

  const selectInstrument = useCallback(
    (selected: SelectedInstrument) => {
      apply({ ric: selected.ric, price: "", stopPrice: "" }, true);
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
    [apply, publishSelection, setSelectedInstrument],
  );

  const nudge = useCallback(
    (field: "price" | "stopPrice" | "quantity", steps: number) => {
      const current = draftRef.current;
      if (field === "price") {
        if (!isPricedOrdType(current.ordType)) return;
        const price = nudgePrice(current, instrument, steps);
        if (price !== undefined) apply({ price }, true);
      } else if (field === "stopPrice") {
        if (!isStopOrdType(current.ordType)) return;
        const stopPrice = nudgeStopPrice(current, instrument, steps);
        if (stopPrice !== undefined) apply({ stopPrice }, true);
      } else {
        apply(
          { quantity: nudgeQuantity(current.quantity, instrument, steps) },
          true,
        );
      }
    },
    [apply, instrument],
  );

  const setPriceFrom = useCallback(
    (price: number | undefined) => {
      if (price === undefined || !isPricedOrdType(draftRef.current.ordType))
        return;
      apply({ price: formatPriceInput(price, instrument) }, true);
    },
    [apply, instrument],
  );

  /**
   * Set one strategy parameter (input text); `commit` for a value picked
   * rather than typed.
   */
  const setAlgoParam = useCallback(
    (key: AlgoParamKey, text: string, commit = false) =>
      apply(
        { algoParams: { ...draftRef.current.algoParams, [key]: text } },
        commit,
      ),
    [apply],
  );

  /**
   * Replace shorthand in a field with what it means (`b+1` → 435.8,
   * `$250k` → 45,200) and commit it, e.g. when the field is left. `text`
   * is the input's live value (fast typing can be ahead of the draft).
   */
  const resolveShorthand = useCallback(
    (field: "price" | "stopPrice" | "quantity", text?: string) => {
      const current = draftRef.current;
      const input = text ?? current[field];
      let resolved = input;
      if (field === "price" || field === "stopPrice") {
        if (isPriceShorthand(input)) {
          const price = resolvePriceInput(input, instrument);
          if (price !== undefined && Number.isFinite(price))
            resolved = formatPriceInput(price, instrument);
        }
      } else if (isValueInput(input)) {
        const quantity = resolveQuantityInput(
          input,
          instrument,
          previewRisk(
            { ...current, quantity: input },
            instrument,
            undefined,
            riskOptions,
          ).price,
          usdPerPriceUnit,
        );
        if (Number.isFinite(quantity)) resolved = String(quantity);
      }
      if (resolved !== current[field]) {
        setDraft({ ...current, [field]: resolved });
        editingRef.current.add(field);
      }
      if (editingRef.current.has(field)) commitFields([field]);
    },
    [commitFields, instrument, riskOptions, setDraft, usdPerPriceUnit],
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
      if (change.ric && change.ric !== draftRef.current.ric) {
        if (change.price === undefined) change.price = "";
        if (change.stopPrice === undefined) change.stopPrice = "";
        if (publishSelection) {
          setSelectedInstrument(
            { ric: change.ric },
            ORDER_TICKET_SELECTION_SOURCE,
          );
        }
      }
      apply(change, true);
      return true;
    },
    [apply, publishSelection, setSelectedInstrument],
  );

  const reset = useCallback(() => {
    setDraft({ ...baseline, account: draftRef.current.account });
    setLocalErrors(() => ({}));
    commitFields(ENTRY_FIELDS);
    setTouched({});
    setSubmitAttempted(false);
    setSubmission({ state: "idle" });
    setTifNotice(undefined);
    setTypeNotice(undefined);
    setReviewing(false);
  }, [baseline, commitFields, setDraft, setLocalErrors]);

  const dirty =
    submission.state !== "idle" ||
    (Object.keys(baseline) as (keyof OrderDraft)[]).some(
      (key) => key !== "account" && baseline[key] !== draft[key],
    );

  const submit = useCallback(
    async ({ confirmed = false } = {}) => {
      if (submission.state === "pending") return;
      setSubmitAttempted(true);
      // Blocked while the connection is down (also F9 / Ctrl+Enter).
      if (blockedReason) return;
      // Send what is being typed, and check the row once it shows it.
      commitFields([...editingRef.current]);
      const inflight = [...inflightRef.current];
      if (inflight.length > 0) {
        await Promise.allSettled(inflight);
        await nextRow(ROW_WAIT_MS);
      }
      const id = entryIdRef.current;
      const current = rowRef.current;
      if (!id || !current) return;
      if (Object.keys(localErrorsRef.current).length > 0) return;
      const rowMessages = decodeEntryMessages(
        current.vuuMsg as string | undefined,
      );
      if (hasEntryErrors(rowMessages)) return;
      if (entryReviewMessages(rowMessages).length > 0 && !confirmed) {
        setReviewing(true);
        return;
      }
      setReviewing(false);
      const sentClOrdId = newClOrdId(clOrdIdPrefix);
      const accountId = String(current.account);
      const base: TradingOrderEvent = {
        kind: "submitted",
        clOrdId: sentClOrdId,
        ric: String(current.ric),
        side: current.side as Side,
        quantity: Number(current.quantity),
        price: isPricedOrdType(current.ordType as OrdType)
          ? Number(current.price)
          : undefined,
        account: accountId,
        currency: instrumentRef.current?.currency,
      };
      lastStatus.current = {};
      setSubmission({ state: "pending", clOrdId: sentClOrdId });
      if (rememberAccount) writeLastAccount(accountId);
      try {
        // The ticket's parentOrders data source is filtered on this clOrdId
        // so the live order shows.
        ordersDataSource.filter = {
          filter: `clOrdId = ${filterString(sentClOrdId)}`,
        };
        const result = await sendTradingRpc(
          entryDataSource,
          "sendOrder",
          { entryId: id, confirmed, clOrdId: sentClOrdId },
          { connectionState },
        );
        setSubmission({
          state: "accepted",
          clOrdId: sentClOrdId,
          orderId: result.orderId,
          status: result.status,
        });
        // Ready for the next order: the OMS keeps instrument, side, price
        // and strategy, and clears the size.
        editingRef.current.delete("quantity");
        setDraft({ ...draftRef.current, quantity: "" });
        setTouched({});
        setSubmitAttempted(false);
        const kind = orderEventKindForStatus(result.status) ?? "ack";
        emit({ ...base, kind, orderId: result.orderId, status: result.status });
      } catch (error) {
        const { reason, text } =
          error instanceof TradingRpcError
            ? error
            : { reason: "INTERNAL_ERROR", text: String(error) };
        setSubmission({
          state: "rejected",
          clOrdId: sentClOrdId,
          reason,
          text,
        });
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
      commitFields,
      connectionState,
      emit,
      entryDataSource,
      nextRow,
      ordersDataSource,
      rememberAccount,
      setDraft,
      submission.state,
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
        else if (field?.startsWith("param:"))
          commit(field.slice(6) as AlgoParamKey);
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
          if (next !== undefined) setAlgoParam(k, next, true);
        }
      }
    },
    [
      commit,
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
    /** Commit a field typed in (call when it is left). */
    commit,
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
    /** The orderEntry row's key, once opened. */
    entryId,
    /** Everything the OMS says about the row (vuuMsg). */
    messages,
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
