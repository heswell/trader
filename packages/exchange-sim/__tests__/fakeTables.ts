import { createExchangeTableDefs } from "@heswell/trading-schemas/server";
import type {
  ExchangeTables,
  PublishTable,
  RowValue,
} from "../src/publish/MarketDataPublisher";

/** Minimal in-memory PublishTable with op counters, for unit tests. */
export class FakeTable implements PublishTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly { name: string }[];
  readonly #keyIdx: number;
  readonly rowsByKey = new Map<string, RowValue[]>();
  inserts = 0;
  updates = 0;
  deletes = 0;

  constructor(columns: readonly { name: string }[], keyField: string) {
    this.columns = columns;
    this.columnMap = Object.fromEntries(
      columns.map(({ name }, i) => [name, i]),
    );
    this.#keyIdx = this.columnMap[keyField];
  }

  get ops() {
    return this.inserts + this.updates + this.deletes;
  }

  get rowCount() {
    return this.rowsByKey.size;
  }

  insert(row: RowValue[]) {
    this.inserts++;
    this.rowsByKey.set(String(row[this.#keyIdx]), row);
  }

  update(rowIdx: number, row: RowValue[]) {
    if (rowIdx < 0) throw Error("update of missing row");
    this.updates++;
    this.rowsByKey.set(String(row[this.#keyIdx]), row);
  }

  delete(key: string) {
    this.deletes++;
    return this.rowsByKey.delete(key);
  }

  rowIndexAtKey(key: string) {
    return this.rowsByKey.has(key) ? 0 : -1;
  }

  get(key: string) {
    const row = this.rowsByKey.get(key);
    if (!row) return undefined;
    return Object.fromEntries(
      this.columns.map(({ name }, i) => [name, row[i]]),
    ) as Record<string, RowValue>;
  }

  all() {
    return [...this.rowsByKey.keys()].map(
      (key) => this.get(key) as Record<string, RowValue>,
    );
  }

  resetCounts() {
    this.inserts = this.updates = this.deletes = 0;
  }
}

export type FakeExchangeTables = { [K in keyof ExchangeTables]: FakeTable };

export const createFakeTables = (): FakeExchangeTables => {
  const defs = createExchangeTableDefs();
  const make = (def: (typeof defs)[keyof typeof defs]) =>
    new FakeTable(def.columns, def.keyField);
  return {
    instruments: make(defs.instruments),
    prices: make(defs.prices),
    depth: make(defs.depth),
    trades: make(defs.trades),
  };
};
