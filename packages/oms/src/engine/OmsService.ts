import { Random } from "@heswell/exchange-sim/engine";
import {
  DEFAULT_OMS_CONFIG,
  type OmsConfig,
  splitList,
  validateOmsConfig,
} from "../config";
import { BackgroundFlow } from "../flow/BackgroundFlow";
import {
  type AccessScope,
  type PermissionMode,
  resolveAccess,
  type TradingUser,
} from "../permissions/access";
import { type Account, SEED_ACCOUNTS } from "../reference/accounts";
import { TableSink } from "../modules/oms/TableSink";
import { DelayedGateway, type OmsGateway, type Scheduler } from "./gateway";
import { OmsEngine } from "./OmsEngine";

/** Structurally a vuu-server Logger, so getLogger("trader.oms") fits. */
export interface OmsLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const consoleLogger: OmsLogger = {
  warn: (...args) => console.warn("[OMS]", ...args),
  error: (...args) => console.error("[OMS]", ...args),
};

export interface OmsServiceOptions {
  /** Defaults to DEFAULT_OMS_CONFIG; usually the result of loadOmsConfig. */
  config?: Partial<OmsConfig>;
  /** Instruments the background flow trades, e.g. () => sim.books.map(b => b.ric). */
  rics?: readonly string[] | (() => readonly string[]);
  accounts?: readonly Account[];
  clock?: () => number;
  /** Scheduler for gatewayLatencyMs (tests inject ManualScheduler.schedule). */
  scheduler?: Scheduler;
  /** Defaults to console; the server passes getLogger("trader.oms"). */
  logger?: OmsLogger;
  /** Engine warnings; defaults to logger.warn (tests capture them). */
  log?: (message: string) => void;
}

/**
 * The OMS: engine + table sink + background flow + timers. OmsModule exposes
 * it to Vuu; tests can drive it directly.
 */
export class OmsService {
  readonly config: OmsConfig;
  readonly engine: OmsEngine;
  readonly flow: BackgroundFlow;
  readonly tables = new TableSink();
  readonly gateway: OmsGateway;
  readonly logger: OmsLogger;
  #timers: ReturnType<typeof setInterval>[] = [];
  #clock: () => number;

  constructor(gateway: OmsGateway, options: OmsServiceOptions = {}) {
    const config = validateOmsConfig({
      ...DEFAULT_OMS_CONFIG,
      ...options.config,
    });
    this.config = config;
    this.logger = options.logger ?? consoleLogger;
    this.#clock = options.clock ?? Date.now;
    this.gateway =
      config.gatewayLatencyMs > 0
        ? new DelayedGateway(
            gateway,
            config.gatewayLatencyMs,
            options.scheduler,
          )
        : gateway;
    const accounts = options.accounts ?? SEED_ACCOUNTS;
    this.engine = new OmsEngine({
      gateway: this.gateway,
      accounts,
      clock: this.#clock,
      sink: this.tables,
      collarPct: config.collarPct,
      restrictedRics: splitList(config.restrictedRics),
      log: options.log ?? ((message) => this.logger.warn(message)),
    });
    const flowAccountIds = new Set(splitList(config.flowAccounts));
    const { rics = [] } = options;
    this.flow = new BackgroundFlow({
      engine: this.engine,
      gateway: this.gateway,
      get rics() {
        return typeof rics === "function" ? rics() : rics;
      },
      accounts: accounts.filter(
        (a) =>
          a.enabled &&
          (flowAccountIds.size === 0 || flowAccountIds.has(a.account)),
      ),
      random: new Random(config.seed),
      rate: config.flowRate,
      notionalUsd: config.flowNotionalUsd,
      maxWorking: config.flowMaxWorking,
      cancelRate: config.flowCancelRate,
    });
  }

  get permissionMode() {
    return this.config.permissionMode as PermissionMode;
  }

  accessFor(user: TradingUser): AccessScope {
    return resolveAccess(
      user,
      [...this.engine.accounts.values()],
      this.permissionMode,
    );
  }

  get running() {
    return this.#timers.length > 0;
  }

  /** Start the background flow and mark-to-market timers. */
  start() {
    if (this.running) return;
    const { flowStepMs, markIntervalMs } = this.config;
    let last = this.#clock();
    this.#timers.push(
      setInterval(() => {
        const now = this.#clock();
        this.flow.step(Math.min(now - last, flowStepMs * 10));
        last = now;
      }, flowStepMs),
    );
    if (markIntervalMs > 0) {
      this.#timers.push(
        setInterval(() => this.engine.markToMarket(), markIntervalMs),
      );
    }
  }

  stop() {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }

  dispose() {
    this.stop();
    this.engine.dispose();
    if (this.gateway instanceof DelayedGateway) this.gateway.dispose();
  }
}

export const createOms = (gateway: OmsGateway, options?: OmsServiceOptions) =>
  new OmsService(gateway, options);
