/**
 * Browser-safe entry point (@heswell/exchange-sim/engine): the simulator,
 * gateway, publisher and transport-independent admin RPC handler, with no
 * dependency on @heswell/vuu-server. Used by @heswell/trading-test-data.
 */
export {
  DEFAULT_CONFIG,
  type ExchangeSimConfig,
  barIntervalList,
  loadExchangeSimConfig,
  validateConfig,
} from "./config";
export {
  createExchangeSimulator,
  ExchangeAdminError,
  ExchangeSimulator,
  type ExchangeSimulatorOptions,
  type SessionStatus,
  type SimulatedInstrument,
  type TapeListener,
} from "./engine/ExchangeSimulator";
export {
  type SessionPhase,
  TradingSession,
  type TradingSessionConfig,
} from "./engine/TradingSession";
export { InstrumentBook } from "./engine/InstrumentBook";
export {
  type ActionContext,
  type BotSelector,
  type InstrumentParams,
  parseParamValue,
  SimControl,
  type SimEvent,
} from "./engine/control/SimControl";
export {
  parseOffset,
  type SavedRun,
  type ScenarioDef,
  type ScenarioRun,
  ScenarioRunner,
  ScenarioStatus,
  type ScenarioStep,
  type StepAction,
} from "./engine/control/ScenarioRunner";
export { BUILT_IN_SCENARIOS } from "../scenarios";
export {
  type Bot,
  BotKind,
  type BotKindDef,
  type BotParamSpec,
  type BotParamValue,
  type BotParams,
  type BotStepContext,
} from "./engine/bots/Bot";
export { BotLedger, type BotLedgerState } from "./engine/bots/BotLedger";
export { MarketMaker, type MarketMakerParams } from "./engine/bots/MarketMaker";
export { MarketSignals } from "./engine/bots/MarketSignals";
export { NoiseTaker, type NoiseTakerParams } from "./engine/bots/NoiseTaker";
export {
  BOT_OWNER_PREFIX,
  botOwner,
  isBotOwner,
  OrderPort,
} from "./engine/bots/OrderPort";
export {
  BOT_KINDS,
  botKindDef,
  defaultRoster,
  type Roster,
  type RosterEntry,
} from "./engine/bots/roster";
export { SimExchangeGateway } from "./gateway/SimExchangeGateway";
export type * from "./gateway/types";
export {
  type ExchangeAdminRpcName,
  handleExchangeAdminRpc,
} from "./modules/exchange/exchangeAdminRpc";
export { handleTimeSeriesRpc } from "./modules/exchange/timeSeriesRpc";
export {
  type HistorySource,
  TimeSeriesError,
  TimeSeriesStore,
  type TimeSeriesStoreOptions,
  type TouchSample,
} from "./history/TimeSeriesStore";
export { TimeSeries } from "./history/TimeSeries";
export * from "./history/downsample";
export { rasterColumns, rasterError } from "./history/rasterError";
export {
  canAdminSim,
  SIM_ADMIN_ROLE,
  type SimPermissionMode,
  type SimUser,
} from "./modules/exchange/simAdminAccess";
export {
  type ExchangeTables,
  MarketDataPublisher,
  type PublisherOptions,
  type PublishTable,
  type TapeTrade,
} from "./publish/MarketDataPublisher";
export {
  type Bar,
  BarAggregator,
  type BarOptions,
  type BackfillBar,
} from "./publish/BarAggregator";
export {
  BookSampler,
  type BookSampleOptions,
  type SampleLevel,
} from "./publish/BookSampler";
export { generateBackfillBars } from "./engine/barBackfill";
export {
  ALL_INSTRUMENTS,
  type InstrumentDef,
  selectActiveInstruments,
} from "./reference/instruments";
export { type Clock, ManualClock, systemClock } from "./util/clock";
export { Random } from "./util/random";
export {
  type BookSettings,
  type BookState,
  type ExchangeJournal,
  type ExchangeJournalEntry,
  type ExchangeRestoreResult,
  type ExchangeState,
  type BookSnapshot,
  type ForcedPhase,
  type ILimitOrder,
  TRADE_ID_BLOCK,
} from "./engine/persistence";
export {
  type GatewayJournal,
  type GatewayState,
  GATEWAY_OWNER,
  idSeq,
} from "./gateway/SimExchangeGateway";
