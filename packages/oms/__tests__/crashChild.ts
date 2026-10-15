/**
 * Child process of the kill -9 test (persistence.test.ts): trades against a
 * FileStore in argv[2], prints the observed state as one JSON line and waits
 * to be killed (SIGKILL: no shutdown snapshot, no flush).
 */
import { FileStore } from "@heswell/trading-persistence/server";
import { boot, observe, trade } from "./persistenceFixture";

const env = boot(new FileStore(process.argv[2], { fsync: true }));
trade(env);
env.engine.flushJournal();
process.stdout.write(`${JSON.stringify(observe(env))}\n`);
setInterval(() => {}, 1_000);
