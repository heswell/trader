import { Histogram } from "../Histogram";
import type { MetricSource } from "../MetricsCollector";

/**
 * One client session's outbound counters (`SessionStats` in vuu-server
 * 4.5.0); counters are cumulative since login.
 */
export interface VuuSessionStats {
  readonly sessionId: string;
  /** The user's name. */
  readonly user: string;
  /** When the session logged in, epoch ms. */
  readonly connectedAt: number;
  readonly queueLength: number;
  readonly rowsQueued: number;
  readonly rowsCoalesced: number;
  readonly rowsSent: number;
  readonly rowsDropped: number;
  readonly messagesSent: number;
  readonly charsSent: number;
}

/** What one vuu-server send cycle did (`SendCycleStats`). */
export interface VuuSendCycle {
  readonly durationMs: number;
}

/**
 * Structural subset of VuuServerCore that the source reads. The session and
 * send-cycle members are optional: vuu-server 4.4.0 does not have them.
 */
export interface VuuServerStats {
  readonly viewPortContainer: { readonly viewportCount: number };
  readonly tableContainer: {
    getDefinedTables(): readonly { module: string; table: string }[];
    getTable(name: string): { readonly rowCount: number };
  };
  readonly sessionCount?: number;
  getSessionStats?(): readonly VuuSessionStats[];
  onSendCycle?(listener: (cycle: VuuSendCycle) => void): () => void;
}

const COUNTERS = [
  "rowsQueued",
  "rowsCoalesced",
  "rowsSent",
  "rowsDropped",
  "messagesSent",
  "charsSent",
] as const satisfies readonly (keyof VuuSessionStats)[];

type Totals = Record<(typeof COUNTERS)[number], number>;

const zero = (): Totals => ({
  rowsQueued: 0,
  rowsCoalesced: 0,
  rowsSent: 0,
  rowsDropped: 0,
  messagesSent: 0,
  charsSent: 0,
});

/**
 * Viewport count and the row count of every Vuu table (session tables
 * excluded). With a vuu-server that reports session stats (trader upstream
 * issue 91), also the client sessions, their outbound queues, rows queued,
 * coalesced, sent and dropped, messages and KB sent, and the send-cycle
 * duration, and a METRICS.metricsSessions row per session. `getServer` may
 * return undefined until the server exists.
 *
 * Session counters are summed into running totals from each session's change
 * since the previous read, so the totals do not fall when a session closes
 * (what a closing session sent after the last read is not counted).
 */
export const vuuServerSource = (
  getServer: () => VuuServerStats | undefined,
): MetricSource => {
  const totals = zero();
  let previous = new Map<string, VuuSessionStats>();
  let lastQueued = 0;
  let lastCoalesced = 0;
  const sendCycle = new Histogram();
  let watching: VuuServerStats | undefined;
  let stopWatching: (() => void) | undefined;

  const watchSendCycles = (server: VuuServerStats) => {
    if (watching === server) return;
    stopWatching?.();
    watching = server;
    stopWatching = server.onSendCycle?.(({ durationMs }) => {
      sendCycle.record(durationMs * 1000);
    });
  };

  return {
    name: "vuu",
    collect(writer) {
      const server = getServer();
      if (!server) return;
      writer.gauge("vuu", "viewports", server.viewPortContainer.viewportCount);

      const sessions = server.getSessionStats?.();
      if (sessions) {
        writer.gauge("vuu", "sessions", server.sessionCount ?? sessions.length);
        const current = new Map<string, VuuSessionStats>();
        let queued = 0;
        let queuedMax = 0;
        for (const stats of sessions) {
          current.set(stats.sessionId, stats);
          queued += stats.queueLength;
          if (stats.queueLength > queuedMax) queuedMax = stats.queueLength;
          const before = previous.get(stats.sessionId);
          for (const key of COUNTERS) {
            totals[key] += stats[key] - (before?.[key] ?? 0);
          }
          writer.session({
            id: stats.sessionId,
            user: stats.user,
            connectedAt: stats.connectedAt,
            queueLength: stats.queueLength,
            rowsQueued: stats.rowsQueued,
            rowsCoalesced: stats.rowsCoalesced,
            rowsSent: stats.rowsSent,
            rowsDropped: stats.rowsDropped,
            messagesSent: stats.messagesSent,
            charsSent: stats.charsSent,
          });
        }
        previous = current;
        writer.gauge("vuu", "queuedRows", queued, "rows");
        writer.gauge("vuu", "queuedRowsMax", queuedMax, "rows");
        writer.counter("vuu", "rowsQueued", totals.rowsQueued, "rows");
        writer.counter("vuu", "rowsCoalesced", totals.rowsCoalesced, "rows");
        writer.counter("vuu", "rowsSent", totals.rowsSent, "rows");
        writer.counter("vuu", "rowsDropped", totals.rowsDropped, "rows");
        writer.counter("vuu", "messagesSent", totals.messagesSent, "msgs");
        writer.counter("vuu", "kbSent", totals.charsSent / 1024, "KB");
        const queuedNow = totals.rowsQueued - lastQueued;
        const coalescedNow = totals.rowsCoalesced - lastCoalesced;
        writer.gauge(
          "vuu",
          "coalescedPct",
          queuedNow > 0 ? (100 * coalescedNow) / queuedNow : 0,
          "%",
        );
        lastQueued = totals.rowsQueued;
        lastCoalesced = totals.rowsCoalesced;
      }

      if (server.onSendCycle) {
        watchSendCycles(server);
        writer.timer("vuu", "sendCycle", sendCycle);
      }

      const { tableContainer } = server;
      for (const { module, table } of tableContainer.getDefinedTables()) {
        writer.tableRows(
          module,
          table,
          tableContainer.getTable(table).rowCount,
        );
      }
    },
  };
};
