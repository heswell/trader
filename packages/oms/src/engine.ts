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
  type OmsServiceOptions,
} from "./engine/OmsService";
export { BackgroundFlow } from "./flow/BackgroundFlow";
export {
  type AccessScope,
  canSeeAccount,
  type PermissionMode,
  resolveAccess,
  TRADING_ROLES,
  TradingRole,
  type TradingUser,
} from "./permissions/access";
export { type Account, SEED_ACCOUNTS } from "./reference/accounts";
export {
  checkPreTradeRisk,
  expectedPrice,
  referencePrice,
  type RiskContext,
} from "./risk/preTradeRisk";
export { handleOmsRpc, type OmsRpcName } from "./modules/oms/omsRpc";
export {
  type OmsTable,
  type OmsTableName,
  TableSink,
} from "./modules/oms/TableSink";
