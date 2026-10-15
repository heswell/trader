/**
 * Browser-safe entry point (@heswell/exchange-sim/engine): the simulator,
 * gateway, publisher and transport-independent admin RPC handler, with no
 * dependency on @heswell/vuu-server. Used by @heswell/trading-test-data.
 */
export {
  DEFAULT_CONFIG,
  type ExchangeSimConfig,
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
export { MM_OWNER } from "./engine/bots/MarketMaker";
export { TAKER_OWNER } from "./engine/bots/NoiseTaker";
export { SimExchangeGateway } from "./gateway/SimExchangeGateway";
export type * from "./gateway/types";
export {
  type ExchangeAdminRpcName,
  handleExchangeAdminRpc,
} from "./modules/exchange/exchangeAdminRpc";
export {
  type ExchangeTables,
  MarketDataPublisher,
  type PublishTable,
  type TapeTrade,
} from "./publish/MarketDataPublisher";
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
