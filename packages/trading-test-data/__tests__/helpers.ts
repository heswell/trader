import type {
  DataSourceRow,
  DataSourceSubscribeCallback,
} from "@vuu-ui/vuu-data-types";

export const tick = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Collects the latest rows (by index) and size sent to a subscriber. */
export const collector = () => {
  const rows = new Map<number, DataSourceRow>();
  let size = -1;
  const callback: DataSourceSubscribeCallback = (message) => {
    if (message.type === "viewport-update") {
      if (message.size !== undefined) size = message.size;
      for (const row of message.rows ?? []) rows.set(row[0], row);
      for (const idx of [...rows.keys()]) if (idx >= size) rows.delete(idx);
    }
  };
  return {
    callback,
    get size() {
      return size;
    },
    rows: () => [...rows.entries()].sort(([a], [b]) => a - b).map(([, r]) => r),
  };
};
