import { Random } from "@heswell/exchange-sim/engine";
import {
  DEFAULT_OMS_CONFIG,
  type OmsConfig,
  splitList,
  validateOmsConfig,
} from "../config";
import { BackgroundFlow } from "../flow/BackgroundFlow";
import { ClientFlow, parseClientBots } from "../flow/ClientFlow";
import { publishClientBots } from "../flow/clientBotRows";
import {
  type AccessScope,
  type PermissionMode,
  resolveAccess,
  type TradingUser,
} from "../permissions/access";
import {
  type Account,
  SEED_ACCOUNTS,
  SIM_CLIENTS_DESK,
  simClientAccounts,
} from "../reference/accounts";
import { TableSink } from "../modules/oms/TableSink";
import { OrderEntryService } from "../entry/OrderEntryService";
import { DelayedGateway, type OmsGateway, type Scheduler } from "./gateway";
import { OmsEngine } from "./OmsEngine";
import { PnlHistory } from "./PnlHistory";

/** How often order ticket rows' messages are rebuilt (ms). */
export const ORDER_ENTRY_REFRESH_MS = 500;

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
  /** Simulated clients sending algo orders (see flow/ClientFlow). */
  readonly clients: ClientFlow;
  readonly tables = new TableSink();
  readonly gateway: OmsGateway;
  readonly logger: OmsLogger;
  /** Order ticket rows (the orderEntry table). */
  readonly orderEntry: OrderEntryService;
  /** P&L history sampler; undefined when oms.pnlHistoryIntervalMs is 0. */
  readonly pnlHistory: PnlHistory | undefined;
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
    const accounts = options.accounts ?? [
      ...SEED_ACCOUNTS,
      ...simClientAccounts(config.clientAccounts),
    ];
    this.engine = new OmsEngine({
      gateway: this.gateway,
      accounts,
      clock: this.#clock,
      sink: this.tables,
      collarPct: config.collarPct,
      restrictedRics: splitList(config.restrictedRics),
      log: options.log ?? ((message) => this.logger.warn(message)),
      algoSliceMs: config.algoSliceMs,
    });
    this.orderEntry = new OrderEntryService({
      engine: this.engine,
      gateway: this.gateway,
      tables: this.tables,
      accessFor: (user) => this.accessFor(user),
      clock: this.#clock,
    });
    if (config.pnlHistoryIntervalMs > 0) {
      this.pnlHistory = new PnlHistory(this.tables, {
        intervalMs: config.pnlHistoryIntervalMs,
        length: config.pnlHistoryLength,
        usdPerPriceUnit: (ric) =>
          this.gateway.getInstrument(ric)?.usdPerPriceUnit ?? 1,
      });
    }
    const flowAccountIds = new Set(splitList(config.flowAccounts));
    const { rics = [] } = options;
    this.flow = new BackgroundFlow({
      engine: this.engine,
      gateway: this.gateway,
      get rics() {
        return typeof rics === "function" ? rics() : rics;
      },
      // the Sim clients desk is the client bots' unless listed
      accounts: accounts.filter(
        (a) =>
          a.enabled &&
          (flowAccountIds.size === 0
            ? a.desk !== SIM_CLIENTS_DESK
            : flowAccountIds.has(a.account)),
      ),
      random: new Random(config.seed),
      rate: config.flowRate,
      notionalUsd: config.flowNotionalUsd,
      maxWorking: config.flowMaxWorking,
      cancelRate: config.flowCancelRate,
    });
    this.clients = new ClientFlow({
      engine: this.engine,
      gateway: this.gateway,
      rics: () => (typeof rics === "function" ? rics() : rics),
      seed: config.seed,
      clock: this.#clock,
    });
    publishClientBots(this.clients, this.tables, this.#clock);
    for (const { persona, count } of parseClientBots(config.clientBots))
      for (let i = 0; i < count; i++)
        this.clients.add(persona, {}, { user: "config" });
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

  /**
   * Mark positions to market, then take a P&L history sample when one is
   * due. Driven by the mark timer (tests and the engine-local data call it).
   */
  mark(now = this.#clock()) {
    const changed = this.engine.markToMarket();
    const history = this.pnlHistory;
    if (history?.due(now)) history.sample(now, this.engine.positions.values());
    return changed;
  }

  /** Start the background flow, algo and mark-to-market timers. */
  start() {
    if (this.running) return;
    const { flowStepMs, markIntervalMs, pnlHistoryIntervalMs, algoSliceMs } =
      this.config;
    this.#timers.push(setInterval(() => this.engine.stepAlgos(), algoSliceMs));
    let last = this.#clock();
    this.#timers.push(
      setInterval(() => {
        const now = this.#clock();
        const elapsed = Math.min(now - last, flowStepMs * 10);
        this.flow.step(elapsed);
        this.clients.step(elapsed);
        last = now;
      }, flowStepMs),
    );
    // Order ticket messages follow prices and phases.
    this.#timers.push(
      setInterval(() => this.orderEntry.refresh(), ORDER_ENTRY_REFRESH_MS),
    );
    // Without a mark timer, P&L history still samples on its own interval.
    const markEvery = markIntervalMs || pnlHistoryIntervalMs;
    if (markEvery > 0) {
      this.#timers.push(setInterval(() => this.mark(), markEvery));
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
