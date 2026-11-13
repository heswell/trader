import type {
  RpcResultError,
  RpcResultSuccess,
  ViewportRpcContext,
} from "@vuu-ui/vuu-protocol-types";
import {
  ALGO_STRATEGIES,
  BOT_TYPES,
  CLIENT_PERSONAS,
  type OrdStatus,
  ORD_TYPES,
  REJECT_REASONS,
  RejectReason,
  SIDES,
  TIME_IN_FORCE_VALUES,
  TimeInForce,
  TradingPhase,
} from "../domain/enums";
import {
  boolean,
  type Infer,
  number,
  object,
  oneOf,
  optional,
  string,
  type ValidationResult,
} from "./validate";

/**
 * RPC contracts. All trading RPCs are sent as RPC_REQUEST with
 * VIEWPORT_CONTEXT (any viewport on a table of the target module) and are
 * registered server-side with DefaultRpcHandler.registerRpc.
 *
 * Params are flat (Vuu restricts RPC params to string | number | boolean).
 * Success: SUCCESS_RESULT with the typed `data` below.
 * Failure: ERROR_RESULT whose errorMessage is `"<RejectReason>: <text>"`
 * (see formatRpcError / parseRpcError).
 */
export const RpcName = Object.freeze({
  CreateOrder: "createOrder",
  AmendOrder: "amendOrder",
  CancelOrder: "cancelOrder",
  CancelAll: "cancelAll",
  SetVolatility: "setVolatility",
  HaltInstrument: "haltInstrument",
  ResumeInstrument: "resumeInstrument",
  SetBotRate: "setBotRate",
  SetMarketPhase: "setMarketPhase",
  SetBotParams: "setBotParams",
  SetInstrumentParams: "setInstrumentParams",
  ShiftFairValue: "shiftFairValue",
  PauseBots: "pauseBots",
  ResumeBots: "resumeBots",
  PullQuotes: "pullQuotes",
  AddBot: "addBot",
  RemoveBot: "removeBot",
  ResetBotStats: "resetBotStats",
  RunScenario: "runScenario",
  StopScenario: "stopScenario",
  SetClientBotParams: "setClientBotParams",
  PauseClientBots: "pauseClientBots",
  ResumeClientBots: "resumeClientBots",
  AddClientBot: "addClientBot",
  RemoveClientBot: "removeClientBot",
  SubmitClientAlgo: "submitClientAlgo",
  SetFlowParams: "setFlowParams",
  OpenOrderEntry: "openOrderEntry",
  UpdateOrderEntry: "updateOrderEntry",
  SendOrder: "sendOrder",
  CloseOrderEntry: "closeOrderEntry",
  TimeSeries: "timeSeries",
  SetTimeSeriesWindow: "setTimeSeriesWindow",
  CloseTimeSeries: "closeTimeSeries",
} as const);
export type RpcName = (typeof RpcName)[keyof typeof RpcName];

export const OMS_RPC_NAMES = Object.freeze([
  RpcName.CreateOrder,
  RpcName.AmendOrder,
  RpcName.CancelOrder,
  RpcName.CancelAll,
] as const);
export const EXCHANGE_ADMIN_RPC_NAMES = Object.freeze([
  RpcName.SetVolatility,
  RpcName.HaltInstrument,
  RpcName.ResumeInstrument,
  RpcName.SetBotRate,
  RpcName.SetMarketPhase,
  RpcName.SetBotParams,
  RpcName.SetInstrumentParams,
  RpcName.ShiftFairValue,
  RpcName.PauseBots,
  RpcName.ResumeBots,
  RpcName.PullQuotes,
  RpcName.AddBot,
  RpcName.RemoveBot,
  RpcName.ResetBotStats,
  RpcName.RunScenario,
  RpcName.StopScenario,
] as const);
/** Order ticket rows (orderEntry): open, edit several fields, send, close. */
export const ORDER_ENTRY_RPC_NAMES = Object.freeze([
  RpcName.OpenOrderEntry,
  RpcName.UpdateOrderEntry,
  RpcName.SendOrder,
  RpcName.CloseOrderEntry,
] as const);
/**
 * Read-only EXCHANGE RPCs anyone can call (no sim-admin): downsampled
 * history for charts.
 */
export const EXCHANGE_QUERY_RPC_NAMES = Object.freeze([
  RpcName.TimeSeries,
  RpcName.SetTimeSeriesWindow,
  RpcName.CloseTimeSeries,
] as const);
/** OMS simulator control (sim-admin): client bots and the background flow. */
export const CLIENT_ADMIN_RPC_NAMES = Object.freeze([
  RpcName.SetClientBotParams,
  RpcName.PauseClientBots,
  RpcName.ResumeClientBots,
  RpcName.AddClientBot,
  RpcName.RemoveClientBot,
  RpcName.SubmitClientAlgo,
  RpcName.SetFlowParams,
] as const);

const id = string({ maxLength: 64 });
const ric = string({ maxLength: 32 });
const positiveQty = number({ greaterThan: 0 });
const positivePrice = number({ greaterThan: 0 });

// ---------------------------------------------------------------- OMS

export const createOrderParams = object({
  /** Client-assigned id, echoed back; must be unique per trader if supplied. */
  clOrdId: optional(id),
  account: id,
  ric,
  side: oneOf(SIDES),
  ordType: oneOf(ORD_TYPES),
  quantity: positiveQty,
  /** Required for LIMIT / STOP_LIMIT, must be omitted / 0 for MARKET / STOP. */
  price: optional(number({ min: 0 })),
  timeInForce: optional(oneOf(TIME_IN_FORCE_VALUES)),
  /**
   * Required for STOP / STOP_LIMIT: the OMS holds the order until a trade
   * reaches it (buy at or above, sell at or below), then sends a MARKET
   * (STOP) or LIMIT at `price` (STOP_LIMIT). Must be beyond the market price
   * when entered. Stops are DMA only, DAY or GTC.
   */
  stopPrice: optional(positivePrice),
  /** How the OMS works the order; default DMA (one child sent at once). */
  strategy: optional(oneOf(ALGO_STRATEGIES)),
  /**
   * TWAP / POV: how long to work the order, in session minutes (scaled when
   * the exchange runs a compressed day). Default 30 for TWAP; POV runs to
   * the close when omitted.
   */
  durationMins: optional(number({ greaterThan: 0, max: 1440 })),
  /**
   * VWAP (or TWAP / POV instead of durationMins): session time "HH:MM" to
   * finish by. VWAP defaults to the session close.
   */
  endTime: optional(string({ maxLength: 5 })),
  /** POV: target share of market volume, in percent. */
  participationPct: optional(number({ greaterThan: 0, max: 50 })),
});
export type CreateOrderRequest = Infer<typeof createOrderParams>;

// ---------------------------------------------------------------- order entry

/**
 * The draft fields of an orderEntry row, all optional. Numbers are 0 when
 * empty and strings may be empty (a cleared field). Business rules (tick,
 * lot, phase, limits) are not checked here: the OMS stores the value and
 * reports them in the row's vuuMsg.
 */
const orderEntryFields = {
  ric: optional(string({ minLength: 0, maxLength: 32 })),
  side: optional(oneOf(SIDES)),
  ordType: optional(oneOf(ORD_TYPES)),
  timeInForce: optional(oneOf(TIME_IN_FORCE_VALUES)),
  quantity: optional(number({ min: 0 })),
  price: optional(number({ min: 0 })),
  stopPrice: optional(number({ min: 0 })),
  account: optional(string({ minLength: 0, maxLength: 64 })),
  strategy: optional(oneOf(ALGO_STRATEGIES)),
  durationMins: optional(number({ min: 0, max: 1440 })),
  endTime: optional(string({ minLength: 0, maxLength: 5 })),
  participationPct: optional(number({ min: 0, max: 50 })),
};

/**
 * Open (or reuse) the caller's row for a ticket. With any draft field the
 * row is reset to those values (the rest default); without, an existing
 * row is kept as it is.
 */
export const openOrderEntryParams = object({
  ticketId: string({ maxLength: 48 }),
  ...orderEntryFields,
});
export type OpenOrderEntryRequest = Infer<typeof openOrderEntryParams>;
export interface OrderEntryResponse {
  entryId: string;
}

/** Set several draft fields at once (an order line, a type change). */
export const updateOrderEntryParams = object({
  entryId: id,
  ...orderEntryFields,
});
export type UpdateOrderEntryRequest = Infer<typeof updateOrderEntryParams>;

/**
 * Send the row as an order. Refused while vuuMsg has errors; warnings that
 * need review need `confirmed`.
 */
export const sendOrderParams = object({
  entryId: id,
  confirmed: optional(boolean()),
  /** Client order id to use (generated by the OMS when omitted). */
  clOrdId: optional(id),
});
export type SendOrderRequest = Infer<typeof sendOrderParams>;

export const closeOrderEntryParams = object({ entryId: id });
export type CloseOrderEntryRequest = Infer<typeof closeOrderEntryParams>;
export interface CreateOrderResponse {
  orderId: string;
  clOrdId?: string;
  status: OrdStatus;
}

/** At least one of quantity / price / stopPrice must be supplied. Quantity is the new total. */
export const amendOrderParams = object({
  orderId: id,
  quantity: optional(positiveQty),
  price: optional(positivePrice),
  /** STOP / STOP_LIMIT only, until the stop has triggered. */
  stopPrice: optional(positivePrice),
});
export type AmendOrderRequest = Infer<typeof amendOrderParams>;
export interface AmendOrderResponse {
  orderId: string;
  status: OrdStatus;
}

export const cancelOrderParams = object({
  orderId: id,
});
export type CancelOrderRequest = Infer<typeof cancelOrderParams>;
export interface CancelOrderResponse {
  orderId: string;
  status: OrdStatus;
}

/** Filter fields are ANDed; an empty filter cancels all of the caller's working orders. */
export const cancelAllParams = object({
  account: optional(id),
  ric: optional(ric),
  side: optional(oneOf(SIDES)),
});
export type CancelAllRequest = Infer<typeof cancelAllParams>;
export interface CancelAllResponse {
  /** Orders for which a cancel was sent. */
  orderIds: string[];
}

// ---------------------------------------------------------------- EXCHANGE admin

/** Omitting ric applies to all simulated instruments. */
export const setVolatilityParams = object({
  ric: optional(ric),
  /** Annualised volatility, e.g. 0.25 = 25%. */
  volatility: number({ min: 0, max: 10 }),
});
export type SetVolatilityRequest = Infer<typeof setVolatilityParams>;

export const haltInstrumentParams = object({
  ric,
  reason: optional(string({ maxLength: 256 })),
});
export type HaltInstrumentRequest = Infer<typeof haltInstrumentParams>;

export const resumeInstrumentParams = object({
  ric,
  /** Re-open via an auction uncross rather than straight to continuous. */
  auction: optional(boolean()),
});
export type ResumeInstrumentRequest = Infer<typeof resumeInstrumentParams>;

/** Omitting ric applies to all simulated instruments; bot defaults to ALL. */
export const setBotRateParams = object({
  ric: optional(ric),
  bot: optional(oneOf(BOT_TYPES)),
  /** Target events per second per instrument (0 pauses the bots). */
  rate: number({ min: 0, max: 100_000 }),
});
export type SetBotRateRequest = Infer<typeof setBotRateParams>;

/** Market-wide phases an exchange session can be forced into. */
export const MARKET_SESSION_PHASES = Object.freeze([
  TradingPhase.PreOpen,
  TradingPhase.Continuous,
  TradingPhase.Closed,
] as const);

/**
 * Force the market-wide session phase now, until the next scheduled phase
 * change (indefinitely when no session is configured). CLOSED expires
 * working DAY orders; halted instruments stay HALTED.
 */
export const setMarketPhaseParams = object({
  phase: oneOf(MARKET_SESSION_PHASES),
});
export type SetMarketPhaseRequest = Infer<typeof setMarketPhaseParams>;

// ---------------------------------------------------------------- simulator control

/**
 * Which bots: one (`botId`), or every bot of `kind` on `ric`; omit both to
 * select every bot (of `kind`) on every simulated instrument.
 */
const botSelector = {
  ric: optional(ric),
  kind: optional(string({ maxLength: 32 })),
  botId: optional(string({ maxLength: 64 })),
};

/**
 * Set one bot parameter (checked against the kind's paramSpec). `value` is
 * absolute ("12", "true") or, for numbers, relative: "x2" multiplies,
 * "+3" / "-3" add. `overSecs` ramps a number there linearly.
 */
export const setBotParamsParams = object({
  ...botSelector,
  name: string({ maxLength: 64 }),
  value: string({ maxLength: 64 }),
  overSecs: optional(number({ min: 0, max: 86_400 })),
});
export type SetBotParamsRequest = Infer<typeof setBotParamsParams>;

/** Price-model settings; omitted fields are unchanged, no ric = all. */
export const setInstrumentParamsParams = object({
  ric: optional(ric),
  volatility: optional(number({ min: 0, max: 10 })),
  /** Trend of the walk, bps per hour of model time. */
  driftBpsPerHour: optional(number({ min: -10_000, max: 10_000 })),
  /** Impact per $100k traded at 30% volatility, bps (0 = off). */
  impactBps: optional(number({ min: 0, max: 1_000 })),
  impactPermanentShare: optional(number({ min: 0, max: 1 })),
  impactHalfLifeSec: optional(number({ min: 0, max: 86_400 })),
});
export type SetInstrumentParamsRequest = Infer<
  typeof setInstrumentParamsParams
>;

/** Move fair value by `bps` at once (a news jump), within the price band. */
export const shiftFairValueParams = object({
  ric,
  bps: number({ min: -5_000, max: 5_000 }),
  /** Arm the instrument's informed traders (adding one if none) for this long. */
  informedSecs: optional(number({ min: 0, max: 3_600 })),
});
export type ShiftFairValueRequest = Infer<typeof shiftFairValueParams>;

/** Pause / resume / pull quotes / reset stats of the selected bots. */
export const botSelectorParams = object(botSelector);
export type BotSelectorRequest = Infer<typeof botSelectorParams>;

export const addBotParams = object({
  ric,
  kind: string({ maxLength: 32 }),
  /** Parameter overrides, as a JSON object of name to value text. */
  params: optional(string({ maxLength: 1_024 })),
});
export type AddBotRequest = Infer<typeof addBotParams>;
export interface AddBotResponse extends AdminRpcResponse {
  botId: string;
}

export const removeBotParams = object({
  botId: string({ maxLength: 64 }),
});
export type RemoveBotRequest = Infer<typeof removeBotParams>;

/**
 * Start a scenario. `rics` (comma separated) overrides its default targets;
 * `args` is a JSON object overriding its default args.
 */
export const runScenarioParams = object({
  name: string({ maxLength: 64 }),
  rics: optional(string({ maxLength: 4_096 })),
  args: optional(string({ maxLength: 1_024 })),
});
export type RunScenarioRequest = Infer<typeof runScenarioParams>;
export interface RunScenarioResponse extends AdminRpcResponse {
  runId: string;
}

/** Stop a live run; `revert` also puts its targets' settings back. */
export const stopScenarioParams = object({
  runId: string({ maxLength: 32 }),
  revert: optional(boolean()),
});
export type StopScenarioRequest = Infer<typeof stopScenarioParams>;

// ---------------------------------------------------------------- client bots (OMS)

/** Which client bots: one (`botId`), or every bot of `persona`; neither = all. */
const clientBotSelector = {
  botId: optional(string({ maxLength: 32 })),
  persona: optional(oneOf(CLIENT_PERSONAS)),
};

/** Set one client bot parameter (checked against its spec); value as setBotParams. */
export const setClientBotParamsParams = object({
  ...clientBotSelector,
  name: string({ maxLength: 64 }),
  value: string({ maxLength: 1_024 }),
});
export type SetClientBotParamsRequest = Infer<typeof setClientBotParamsParams>;

export const clientBotSelectorParams = object(clientBotSelector);
export type ClientBotSelectorRequest = Infer<typeof clientBotSelectorParams>;

/**
 * Add a client bot of `persona`. `account` defaults to the next Sim clients
 * account (CLIENT-nn); any enabled account works, e.g. a trader's for demos.
 * `params` is a JSON object of parameter overrides.
 */
export const addClientBotParams = object({
  persona: oneOf(CLIENT_PERSONAS),
  account: optional(id),
  params: optional(string({ maxLength: 2_048 })),
});
export type AddClientBotRequest = Infer<typeof addClientBotParams>;
export interface AddClientBotResponse {
  botId: string;
  account: string;
}

/** Remove a client bot; its live parent orders are cancelled. */
export const removeClientBotParams = object({
  botId: string({ maxLength: 32 }),
});
export type RemoveClientBotRequest = Infer<typeof removeClientBotParams>;

/**
 * One parent order now, for `botId`'s account: `notionalUsd` (or
 * `quantity`) on `ric`, worked by `strategy` (default the bot's mix).
 * Omitted fields come from the bot's parameters.
 */
export const submitClientAlgoParams = object({
  botId: string({ maxLength: 32 }),
  ric,
  side: optional(oneOf(SIDES)),
  notionalUsd: optional(number({ greaterThan: 0 })),
  quantity: optional(positiveQty),
  strategy: optional(oneOf(ALGO_STRATEGIES)),
  durationMins: optional(number({ greaterThan: 0, max: 1440 })),
  participationPct: optional(number({ greaterThan: 0, max: 50 })),
  /** Limit this far through arrival, bps; 0 = a market parent. */
  limitBps: optional(number({ min: 0, max: 5_000 })),
});
export type SubmitClientAlgoRequest = Infer<typeof submitClientAlgoParams>;

/** BackgroundFlow settings; omitted fields are unchanged. */
export const setFlowParamsParams = object({
  rate: optional(number({ min: 0, max: 1_000 })),
  notionalUsd: optional(number({ greaterThan: 0 })),
  maxWorking: optional(number({ min: 0, max: 10_000 })),
  cancelRate: optional(number({ min: 0, max: 1 })),
});
export type SetFlowParamsRequest = Infer<typeof setFlowParamsParams>;

/** Client bots affected. */
export interface ClientAdminRpcResponse {
  botIds: string[];
}
export interface SetFlowParamsResponse {
  rate: number;
  notionalUsd: number;
  maxWorking: number;
  cancelRate: number;
}

export interface AdminRpcResponse {
  /** Instruments affected. */
  rics: string[];
}

// ---------------------------------------------------------------- time series

/** Fields of the EXCHANGE time-series store (one value per second per ric). */
export const TIME_SERIES_FIELDS = Object.freeze(["mid", "spreadBps"] as const);
export type TimeSeriesField = (typeof TIME_SERIES_FIELDS)[number];

/**
 * How the server picks samples (see docs/timeseries-downsampling.md):
 * `m4` first/min/max/last per time bucket (pixel-exact, constant cost);
 * `minmaxlttb` LTTB over pyramid min/max candidates; `lttb` LTTB over every
 * point in the window (O(n)); `raw` every point (capped at `points`).
 */
export const DOWNSAMPLE_METHODS = Object.freeze([
  "m4",
  "minmaxlttb",
  "lttb",
  "raw",
] as const);
export type DownsampleMethod = (typeof DOWNSAMPLE_METHODS)[number];

/** Most samples a timeSeries request can ask for (per field). */
export const TIME_SERIES_MAX_POINTS = 20_000;

/**
 * Downsampled history of one instrument over `[start, end)` (epoch ms; `end`
 * defaults to now, `start` to an hour before `end`), at most about `points`
 * samples per field. Pass `bucketMs` back from a previous response to
 * re-request part of the window on the same bucket grid (the live edge).
 */
export const timeSeriesParams = object({
  ric,
  /** Comma separated TIME_SERIES_FIELDS, default "mid". */
  fields: optional(string({ maxLength: 64 })),
  start: optional(number({ min: 0 })),
  end: optional(number({ min: 0 })),
  points: number({ min: 4, max: TIME_SERIES_MAX_POINTS }),
  method: optional(oneOf(DOWNSAMPLE_METHODS)),
  bucketMs: optional(number({ min: 1 })),
});
export type TimeSeriesRequest = Infer<typeof timeSeriesParams>;

/**
 * One field's samples. Times are delta encoded: `t[0]` is ms after `t0`,
 * each later `t[i]` ms after `t[i - 1]`. A `null` value is a gap: the line
 * breaks there (its time is between the points either side).
 */
export interface TimeSeriesData {
  field: TimeSeriesField;
  t0: number;
  t: number[];
  v: (number | null)[];
  /** Points in the store inside the requested window. */
  sourcePoints: number;
}

export interface TimeSeriesResponse {
  ric: string;
  start: number;
  end: number;
  method: DownsampleMethod;
  /** Bucket width used (m4 / minmaxlttb), aligned to multiples of itself. */
  bucketMs: number;
  /** Data extent in the store: first and last point time (0 when empty). */
  first: number;
  last: number;
  /** Server clock when answered (the live edge). */
  now: number;
  /** Store interval between points (ms). */
  intervalMs: number;
  series: TimeSeriesData[];
  /** Server time spent selecting and encoding (ms). */
  serverMs: number;
}

/**
 * Open or move a time-series subscription: the M4 buckets of `fields` over
 * `[start, end)` are published as `timeSeriesBuckets` rows with this
 * `subId` (a client-chosen id; filter a viewport on it). Bucket width is the
 * largest base interval × 2^k not wider than `(end - start) / points`, so
 * about one bucket per point. Like a viewport range change: moving the
 * window inserts / deletes only the buckets entering / leaving it; a new
 * width resends all. `follow` slides the window with the live edge (end =
 * now). Re-send at least every TIME_SERIES_LEASE_MS to keep it open.
 */
export const setTimeSeriesWindowParams = object({
  subId: string({ minLength: 1, maxLength: 64 }),
  ric,
  fields: optional(string({ maxLength: 64 })),
  start: number({ min: 0 }),
  end: number({ min: 0 }),
  points: number({ min: 1, max: TIME_SERIES_MAX_POINTS }),
  follow: optional(boolean()),
});
export type SetTimeSeriesWindowRequest = Infer<
  typeof setTimeSeriesWindowParams
>;

/**
 * Bucket width of a time-series window: the largest `baseMs × 2^k` not wider
 * than `spanMs / points` (at least `baseMs`). A fixed ladder, so a zoom
 * inside one level keeps every bucket and buckets never move as the window
 * slides.
 */
export const bucketWidthFor = (
  spanMs: number,
  points: number,
  baseMs: number,
) => {
  const target = spanMs / Math.max(1, points);
  let width = Math.max(1, baseMs);
  while (width * 2 <= target) width *= 2;
  return width;
};

/** A subscription without a window change for this long is closed (ms). */
export const TIME_SERIES_LEASE_MS = 60_000;

export interface SetTimeSeriesWindowResponse {
  subId: string;
  /** Bucket width now published (rows with another width are stale). */
  bucketMs: number;
  /** Published bucket range [from, to). */
  from: number;
  to: number;
  /** Buckets held, all fields. */
  buckets: number;
  /** Rows this change inserted or updated / removed. */
  upserts: number;
  removed: number;
  /** Data extent in the store and the server clock. */
  first: number;
  last: number;
  now: number;
  intervalMs: number;
  /** A step longer than this between points is a gap (break the line). */
  gapMs: number;
  serverMs: number;
}

export const closeTimeSeriesParams = object({
  subId: string({ minLength: 1, maxLength: 64 }),
});
export type CloseTimeSeriesRequest = Infer<typeof closeTimeSeriesParams>;

/** Decode a TimeSeriesData into absolute times and values (gaps as null). */
export const decodeTimeSeries = ({ t0, t, v }: TimeSeriesData) => {
  const times = new Array<number>(t.length);
  let time = t0;
  for (let i = 0; i < t.length; i++) {
    time += t[i];
    times[i] = time;
  }
  return { times, values: v };
};

// ---------------------------------------------------------------- typing

export interface RpcContracts {
  createOrder: [CreateOrderRequest, CreateOrderResponse];
  amendOrder: [AmendOrderRequest, AmendOrderResponse];
  cancelOrder: [CancelOrderRequest, CancelOrderResponse];
  cancelAll: [CancelAllRequest, CancelAllResponse];
  setVolatility: [SetVolatilityRequest, AdminRpcResponse];
  haltInstrument: [HaltInstrumentRequest, AdminRpcResponse];
  resumeInstrument: [ResumeInstrumentRequest, AdminRpcResponse];
  setBotRate: [SetBotRateRequest, AdminRpcResponse];
  setMarketPhase: [SetMarketPhaseRequest, AdminRpcResponse];
  setBotParams: [SetBotParamsRequest, AdminRpcResponse];
  setInstrumentParams: [SetInstrumentParamsRequest, AdminRpcResponse];
  shiftFairValue: [ShiftFairValueRequest, AdminRpcResponse];
  pauseBots: [BotSelectorRequest, AdminRpcResponse];
  resumeBots: [BotSelectorRequest, AdminRpcResponse];
  pullQuotes: [BotSelectorRequest, AdminRpcResponse];
  addBot: [AddBotRequest, AddBotResponse];
  removeBot: [RemoveBotRequest, AdminRpcResponse];
  resetBotStats: [BotSelectorRequest, AdminRpcResponse];
  runScenario: [RunScenarioRequest, RunScenarioResponse];
  stopScenario: [StopScenarioRequest, AdminRpcResponse];
  setClientBotParams: [SetClientBotParamsRequest, ClientAdminRpcResponse];
  pauseClientBots: [ClientBotSelectorRequest, ClientAdminRpcResponse];
  resumeClientBots: [ClientBotSelectorRequest, ClientAdminRpcResponse];
  addClientBot: [AddClientBotRequest, AddClientBotResponse];
  removeClientBot: [RemoveClientBotRequest, ClientAdminRpcResponse];
  submitClientAlgo: [SubmitClientAlgoRequest, CreateOrderResponse];
  setFlowParams: [SetFlowParamsRequest, SetFlowParamsResponse];
  openOrderEntry: [OpenOrderEntryRequest, OrderEntryResponse];
  updateOrderEntry: [UpdateOrderEntryRequest, OrderEntryResponse];
  sendOrder: [SendOrderRequest, CreateOrderResponse];
  closeOrderEntry: [CloseOrderEntryRequest, OrderEntryResponse];
  timeSeries: [TimeSeriesRequest, TimeSeriesResponse];
  setTimeSeriesWindow: [
    SetTimeSeriesWindowRequest,
    SetTimeSeriesWindowResponse,
  ];
  closeTimeSeries: [CloseTimeSeriesRequest, { subId: string }];
}
export type RpcRequestParams<N extends RpcName> = RpcContracts[N][0];
export type RpcResponseData<N extends RpcName> = RpcContracts[N][1];

export interface TradingRpcRequest<N extends RpcName = RpcName> {
  type: "RPC_REQUEST";
  context: ViewportRpcContext;
  rpcName: N;
  params: RpcRequestParams<N>;
}

export type TradingRpcSuccess<N extends RpcName> = RpcResultSuccess & {
  data: RpcResponseData<N>;
};
export type TradingRpcResult<N extends RpcName> =
  | TradingRpcSuccess<N>
  | RpcResultError;

/** Build a client RPC_REQUEST message (send via DataSource.rpcRequest). */
export const tradingRpcRequest = <N extends RpcName>(
  rpcName: N,
  params: RpcRequestParams<N>,
  viewPortId: string,
): TradingRpcRequest<N> => ({
  type: "RPC_REQUEST",
  context: { type: "VIEWPORT_CONTEXT", viewPortId },
  rpcName,
  params,
});

/** A SUCCESS_RESULT carrying the typed response data of an RPC. */
export const rpcSuccess = <N extends RpcName>(
  _rpcName: N,
  data: RpcResponseData<N>,
): TradingRpcSuccess<N> => ({ type: "SUCCESS_RESULT", data });

/**
 * Error message of a reject: `REASON: text` (or the reason alone); parsed by
 * parseRpcError.
 */
export const formatRpcError = (reason: RejectReason, text?: string) =>
  text ? `${reason}: ${text}` : reason;

/** An ERROR_RESULT with the message formatted by formatRpcError. */
export const rpcError = (
  reason: RejectReason,
  text?: string,
): RpcResultError => ({
  type: "ERROR_RESULT",
  errorMessage: formatRpcError(reason, text),
});

/** Split an ERROR_RESULT message into reason code + text. */
export const parseRpcError = (
  errorMessage: string,
): { reason: RejectReason; text: string } => {
  const i = errorMessage.indexOf(":");
  const code = (i === -1 ? errorMessage : errorMessage.slice(0, i)).trim();
  if ((REJECT_REASONS as readonly string[]).includes(code)) {
    return {
      reason: code as RejectReason,
      text: i === -1 ? "" : errorMessage.slice(i + 1).trim(),
    };
  }
  return { reason: RejectReason.InternalError, text: errorMessage };
};

// ---------------------------------------------------------------- validation

const validators = {
  createOrder: createOrderParams,
  amendOrder: amendOrderParams,
  cancelOrder: cancelOrderParams,
  cancelAll: cancelAllParams,
  setVolatility: setVolatilityParams,
  haltInstrument: haltInstrumentParams,
  resumeInstrument: resumeInstrumentParams,
  setBotRate: setBotRateParams,
  setMarketPhase: setMarketPhaseParams,
  setBotParams: setBotParamsParams,
  setInstrumentParams: setInstrumentParamsParams,
  shiftFairValue: shiftFairValueParams,
  pauseBots: botSelectorParams,
  resumeBots: botSelectorParams,
  pullQuotes: botSelectorParams,
  addBot: addBotParams,
  removeBot: removeBotParams,
  resetBotStats: botSelectorParams,
  runScenario: runScenarioParams,
  stopScenario: stopScenarioParams,
  setClientBotParams: setClientBotParamsParams,
  pauseClientBots: clientBotSelectorParams,
  resumeClientBots: clientBotSelectorParams,
  addClientBot: addClientBotParams,
  removeClientBot: removeClientBotParams,
  submitClientAlgo: submitClientAlgoParams,
  setFlowParams: setFlowParamsParams,
  openOrderEntry: openOrderEntryParams,
  updateOrderEntry: updateOrderEntryParams,
  sendOrder: sendOrderParams,
  closeOrderEntry: closeOrderEntryParams,
  timeSeries: timeSeriesParams,
  setTimeSeriesWindow: setTimeSeriesWindowParams,
  closeTimeSeries: closeTimeSeriesParams,
} as const;

/**
 * Structural validation of RPC params (types, enums, required fields).
 * createOrder defaults timeInForce to DAY. Business rules against the
 * instrument (tick/lot, phase) are in validateOrder.
 */
export function validateRpcParams<N extends RpcName>(
  rpcName: N,
  params: unknown,
): ValidationResult<RpcRequestParams<N>> {
  const validator = validators[rpcName];
  if (!validator) {
    return { ok: false, errors: [`unknown rpc ${rpcName}`] };
  }
  const result = validator(params, "params") as ValidationResult<
    RpcRequestParams<N>
  >;
  if (!result.ok) return result;
  if (rpcName === RpcName.CreateOrder) {
    const v = result.value as CreateOrderRequest;
    v.timeInForce ??= TimeInForce.Day;
  }
  if (rpcName === RpcName.AmendOrder) {
    const v = result.value as AmendOrderRequest;
    if (
      v.quantity === undefined &&
      v.price === undefined &&
      v.stopPrice === undefined
    ) {
      return {
        ok: false,
        errors: ["params: one of quantity, price or stopPrice is required"],
      };
    }
  }
  return result;
}
