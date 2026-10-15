import { join } from "node:path";
import { FileStore } from "./FileStore";
import { MemoryStore } from "./MemoryStore";
import { SqliteStore } from "./SqliteStore";
import type { PersistenceStore, StoreKind } from "./types";

export { FileStore, LOCK } from "./FileStore";
export { acquireLock, lockHolder } from "./lock";
export { SqliteStore } from "./SqliteStore";
export * from "./index";

export interface StoreConfig {
  store: StoreKind;
  /** Directory for the file store; the sqlite store uses `<dir>/trading.sqlite`. */
  dir: string;
  fsync?: boolean;
}

export const SQLITE_FILE = "trading.sqlite";

/** Create the configured store (Bun/Node only: file and sqlite use the filesystem). */
export const createStore = ({
  store,
  dir,
  fsync = false,
}: StoreConfig): PersistenceStore => {
  switch (store) {
    case "memory":
      return new MemoryStore();
    case "file":
      return new FileStore(dir, { fsync });
    case "sqlite":
      return new SqliteStore(join(dir, SQLITE_FILE), { fsync });
    default:
      throw Error(`unknown persistence store "${store}" (memory|file|sqlite)`);
  }
};
