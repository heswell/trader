/**
 * Browser-safe entry point (@heswell/oms/engine): the OMS engine, service,
 * permissions and transport-independent RPC handler, with no dependency on
 * @heswell/vuu-server. Used by @heswell/trading-test-data.
 */
export {
  type ConfigSource,
  DEFAULT_OMS_CONFIG,
  loadOmsConfig,
  type OmsConfig,
  validateOmsConfig,
} from "./config";
export {
  newOrderState,
  type OrderEvent,
  type OrderState,
  OrderStateError,
  reduceOrder,
  reduceOrderEvents,
} from "./domain/orderState";
export {
  applyFill,
  FLAT_POSITION,
  markPosition,
  type PositionMarks,
  type PositionState,
} from "./domain/positionMath";
export {
  DelayedGateway,
  ManualScheduler,
  type OmsGateway,
  type Scheduler,
} from "./engine/gateway";
export {
  type ChildOrder,
  executionQuality,
  type Fill,
  OmsEngine,
  type OmsEngineOptions,
  type OmsResult,
  type OmsSink,
  type ParentOrder,
  type Position,
  type RequestContext,
} from "./engine/OmsEngine";
export {
  createOms,
  OmsService,
  type OmsLogger,
  type OmsServiceOptions,
} from "./engine/OmsService";
export {
  type AccountPnlHistoryRow,
  PnlHistory,
  type PnlHistoryOptions,
  type PnlHistoryRow,
  type PnlHistorySink,
} from "./engine/PnlHistory";
export { BackgroundFlow } from "./flow/BackgroundFlow";
export {
  ClientAdminError,
  ClientBot,
  type ClientBotSelector,
  ClientFlow,
  type ClientFlowEvent,
  type ClientMarketHooks,
  parseClientBots,
} from "./flow/ClientFlow";
export {
  CLIENT_PARAM_SPECS,
  type ClientBotParams,
  PERSONA_DEFAULTS,
} from "./flow/clientPersonas";
export {
  CLIENT_SCENARIOS,
  connectClientFlowToSim,
} from "./flow/simScenarios";
export {
  type ClientAdminRpcName,
  handleClientAdminRpc,
} from "./modules/oms/clientAdminRpc";
export {
  type AccessScope,
  canSeeAccount,
  type PermissionMode,
  resolveAccess,
  TRADING_ROLES,
  TradingRole,
  type TradingUser,
} from "./permissions/access";
export {
  type Account,
  SEED_ACCOUNTS,
  SIM_CLIENTS_DESK,
  SIM_CLIENTS_OWNER,
  simClientAccounts,
} from "./reference/accounts";
export {
  checkPreTradeRisk,
  expectedPrice,
  riskLimitBreaches,
  referencePrice,
  type RiskContext,
} from "./risk/preTradeRisk";
export { handleOmsRpc, type OmsRpcName } from "./modules/oms/omsRpc";
export {
  EMPTY_ORDER_ENTRY,
  ORDER_ENTRY_IDLE_MS,
  type OrderEntryFields,
  OrderEntryService,
  type OrderEntryServiceOptions,
} from "./entry/OrderEntryService";
export {
  handleOrderEntryEditCell,
  handleOrderEntryRpc,
  type OrderEntryRpcName,
} from "./entry/orderEntryRpc";
export {
  type OmsTable,
  type OmsTableName,
  TableSink,
} from "./modules/oms/TableSink";
export {
  exchangeMetricsSource,
  omsMetricsSource,
} from "./metrics/tradingSources";
