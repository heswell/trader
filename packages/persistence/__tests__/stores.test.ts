import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  FileStore,
  MemoryStore,
  type PersistenceStore,
  SqliteStore,
} from "../src/server";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "trader-persistence-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Kind {
  name: string;
  /** Open a store on the same backing location each call. */
  factory: () => () => PersistenceStore;
}

const kinds: Kind[] = [
  {
    name: "memory",
    factory: () => {
      const store = new MemoryStore();
      return () => store;
    },
  },
  {
    name: "file",
    factory: () => {
      const dir = tempDir();
      return () => new FileStore(dir);
    },
  },
  {
    name: "sqlite",
    factory: () => {
      const file = join(tempDir(), "t.sqlite");
      return () => new SqliteStore(file);
    },
  },
];

describe.each(kinds)("$name store", ({ factory }) => {
  test("empty load", () => {
    const store = factory()();
    expect(store.load()).toEqual({ snapshot: undefined, entries: [], warnings: [] });
    store.close();
  });

  test("journal survives reopen, in order, with increasing seq", () => {
    const open = factory();
    const a = open();
    a.load();
    expect(a.append("exchange", { k: "x", n: 1 }, 10)).toBe(1);
    expect(a.append("oms", { k: "y" }, 11)).toBe(2);
    expect(a.entriesSinceSnapshot).toBe(2);
    a.close();
    const b = open();
    const loaded = b.load();
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.entries).toEqual([
      { seq: 1, ts: 10, stream: "exchange", data: { k: "x", n: 1 } },
      { seq: 2, ts: 11, stream: "oms", data: { k: "y" } },
    ]);
    expect(b.append("oms", { k: "z" }, 12)).toBe(3);
    b.close();
  });

  test("snapshot compacts the journal and later entries follow it", () => {
    const open = factory();
    const a = open();
    a.load();
    a.append("oms", 1, 1);
    a.append("oms", 2, 2);
    a.snapshot({ oms: { n: 2 }, exchange: { t: 0 } }, 3);
    expect(a.entriesSinceSnapshot).toBe(0);
    a.append("oms", 3, 4);
    a.close();
    const b = open();
    const loaded = b.load();
    expect(loaded.snapshot).toEqual({ seq: 2, ts: 3, data: { oms: { n: 2 }, exchange: { t: 0 } } });
    expect(loaded.entries).toEqual([{ seq: 3, ts: 4, stream: "oms", data: 3 }]);
    expect(b.entriesSinceSnapshot).toBe(1);
    b.snapshot({ oms: { n: 3 } }, 5);
    b.close();
    const c = open();
    expect(c.load()).toEqual({ snapshot: { seq: 3, ts: 5, data: { oms: { n: 3 } } }, entries: [], warnings: [] });
    expect(c.append("oms", 4, 6)).toBe(4);
    c.close();
  });

  test("stored data is a copy", () => {
    const store = factory()();
    store.load();
    const data = { n: 1 };
    store.append("oms", data, 1);
    data.n = 2;
    expect(store.load().entries[0].data).toEqual({ n: 1 });
    store.close();
  });

  test("clear removes everything", () => {
    const open = factory();
    const a = open();
    a.load();
    a.append("oms", 1, 1);
    a.snapshot({ oms: 1 }, 2);
    a.append("oms", 2, 3);
    a.clear();
    a.close();
    const b = open();
    expect(b.load()).toEqual({ snapshot: undefined, entries: [], warnings: [] });
    b.close();
  });
});

describe("file store", () => {
  test("drops a torn last line with a warning and keeps appending", () => {
    const dir = tempDir();
    const a = new FileStore(dir);
    a.load();
    a.append("oms", { n: 1 }, 1);
    a.append("oms", { n: 2 }, 2);
    a.close();
    const [segment] = readdirSync(dir).filter((f) => f.startsWith("journal-"));
    appendFileSync(join(dir, segment), '{"seq":3,"ts":3,"s":"oms","d":{"n"');
    const b = new FileStore(dir);
    const loaded = b.load();
    expect(loaded.entries.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(loaded.warnings[0]).toContain("torn last line");
    expect(b.append("oms", { n: 3 }, 3)).toBe(3);
    b.close();
    const c = new FileStore(dir);
    expect(c.load().entries.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    c.close();
  });

  test("a corrupt line before the end fails the load", () => {
    const dir = tempDir();
    const a = new FileStore(dir);
    a.load();
    a.append("oms", 1, 1);
    a.close();
    const [segment] = readdirSync(dir).filter((f) => f.startsWith("journal-"));
    appendFileSync(join(dir, segment), 'garbage\n{"seq":3,"ts":3,"s":"oms","d":3}\n');
    expect(() => new FileStore(dir).load()).toThrow("corrupt journal entry");
  });

  test("ignores an unfinished snapshot temp file", () => {
    const dir = tempDir();
    const a = new FileStore(dir);
    a.load();
    a.append("oms", 1, 1);
    a.snapshot({ oms: 1 }, 2);
    a.close();
    appendFileSync(join(dir, "snapshot-000000000009.json.tmp"), "{");
    const b = new FileStore(dir);
    expect(b.load().snapshot?.data).toEqual({ oms: 1 });
    b.close();
  });

  test("a live process holding the dir blocks a second store", () => {
    const dir = tempDir();
    appendFileSync(join(dir, "LOCK"), String(process.ppid));
    expect(() => new FileStore(dir)).toThrow("is in use by process");
  });

  test("a stale lock (dead pid) is taken over", () => {
    const dir = tempDir();
    appendFileSync(join(dir, "LOCK"), "999999999");
    const store = new FileStore(dir);
    store.close();
  });
});

describe("createStore", () => {
  test("creates each kind", () => {
    const dir = tempDir();
    for (const store of ["memory", "file", "sqlite"] as const) {
      const s = createStore({ store, dir });
      expect(s.kind).toBe(store);
      s.close();
    }
    expect(() => createStore({ store: "duckdb" as never, dir })).toThrow("unknown persistence store");
  });
});
