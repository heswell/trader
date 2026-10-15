/**
 * bun run persistence:reset [dir]
 *
 * Delete the persisted trading state (exchange books, OMS orders / fills /
 * positions, id counters) of the file and sqlite stores in `dir` (default
 * TRADER_DATA_DIR / PERSISTENCE_DIR, else .data/trading under the repo root).
 * Refuses while a trading server holds the store; stop it first, or start the
 * server with TRADER_PERSISTENCE_RESET=1 instead. See docs/persistence.md.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FileStore,
  LOCK,
  lockHolder,
  SQLITE_FILE,
  SqliteStore,
} from "@heswell/trading-persistence/server";

const root = resolve(import.meta.dir, "..");
const dir = resolve(
  root,
  process.argv[2] ??
    process.env.TRADER_DATA_DIR ??
    process.env.PERSISTENCE_DIR ??
    ".data/trading",
);

if (!existsSync(dir)) {
  console.log(`nothing to reset: ${dir} does not exist`);
  process.exit(0);
}
const sqlite = join(dir, SQLITE_FILE);
for (const lock of [join(dir, LOCK), `${sqlite}.lock`]) {
  const pid = lockHolder(lock);
  if (pid !== undefined) {
    console.error(
      `refusing to reset ${dir}: in use by process ${pid} (stop the trading server, or start it with TRADER_PERSISTENCE_RESET=1)`,
    );
    process.exit(1);
  }
}
const file = new FileStore(dir);
file.clear();
file.close();
if (existsSync(sqlite)) {
  const db = new SqliteStore(sqlite);
  db.clear();
  db.close();
}
console.log(`reset persisted trading state in ${dir}`);
