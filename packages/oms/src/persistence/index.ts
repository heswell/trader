/**
 * Server-only entry point (@heswell/oms/persistence): durable exchange + OMS
 * state through a file / sqlite store. See docs/persistence.md.
 */
import { resolve } from "node:path";
import type { ExchangeSimulator } from "@heswell/exchange-sim/engine";
import {
  createStore,
  type StoreKind,
} from "@heswell/trading-persistence/server";
import type { OmsEngine } from "../engine/OmsEngine";
import type { PersistenceConfig } from "./config";
import { TradingPersistence } from "./TradingPersistence";

export * from "./config";
export * from "./TradingPersistence";

export interface CreateTradingPersistenceOptions {
  config: PersistenceConfig;
  sim: ExchangeSimulator;
  engine: OmsEngine;
  /** Base for a relative `dir` (default: the cwd). */
  baseDir?: string;
  log?: (message: string) => void;
}

/** Open the configured store (clearing it if `reset`) and build the coordinator. */
export const createTradingPersistence = ({
  config,
  sim,
  engine,
  baseDir = process.cwd(),
  log,
}: CreateTradingPersistenceOptions) => {
  const store = createStore({
    store: config.store as StoreKind,
    dir: resolve(baseDir, config.dir),
    fsync: config.fsync === 1,
  });
  if (config.reset === 1) {
    store.clear();
    log?.(`reset: cleared persisted state in ${store.kind}:${store.location}`);
  }
  return new TradingPersistence({
    store,
    sim,
    engine,
    snapshotIntervalMs: config.snapshotIntervalMs,
    snapshotEveryEntries: config.snapshotEveryEntries,
    cancelOrphans: config.cancelOrphans === 1,
    log,
  });
};
