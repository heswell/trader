import type { MetricSource } from "../MetricsCollector";

/** Structural subset of VuuServerCore that the source reads. */
export interface VuuServerStats {
  readonly viewPortContainer: { readonly viewportCount: number };
  readonly tableContainer: {
    getDefinedTables(): readonly { module: string; table: string }[];
    getTable(name: string): { readonly rowCount: number };
  };
}

/**
 * Viewport count and the row count of every Vuu table (session tables
 * excluded). `getServer` may return undefined until the server exists.
 * vuu-server has no per-session send-cycle or queue stats yet (trader
 * upstream issue 91).
 */
export const vuuServerSource = (
  getServer: () => VuuServerStats | undefined,
): MetricSource => ({
  name: "vuu",
  collect(writer) {
    const server = getServer();
    if (!server) return;
    writer.gauge("vuu", "viewports", server.viewPortContainer.viewportCount);
    const { tableContainer } = server;
    for (const { module, table } of tableContainer.getDefinedTables()) {
      writer.tableRows(module, table, tableContainer.getTable(table).rowCount);
    }
  },
});
