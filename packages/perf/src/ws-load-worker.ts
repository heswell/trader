/**
 * WS load worker (spawned by ws-load.ts over IPC): opens its share of the
 * load clients, each with its viewports, counts rows only between the
 * parent's "start" and "stop" messages, then reports per-client results.
 */
import { type ViewportSpec, VuuPerfClient } from "./lib/vuuPerfClient";

export interface WorkerClientSpec {
  id: string;
  token: string;
  viewports: ViewportSpec[];
}

export interface WorkerInit {
  type: "init";
  wsUrl: string;
  insecure: boolean;
  clients: WorkerClientSpec[];
}

export interface ViewportResult {
  kind: string;
  rows: number;
  sizeOnly: number;
  seqGaps: number;
  seqUpdates: number;
  latency: number[];
}

export interface ClientResult {
  id: string;
  messages: number;
  bytes: number;
  wireLatency: number[];
  viewports: ViewportResult[];
  closed?: { code: number; reason: string };
}

export type WorkerMessage =
  | { type: "ready"; errors: string[] }
  | {
      type: "result";
      clients: ClientResult[];
      elapsedMs: number;
      cpuMs: number;
    };

/** Latency samples sent to the parent per client (bounded IPC payload). */
const MAX_SAMPLES = 5_000;
const sample = (values: number[]) =>
  values.length <= MAX_SAMPLES
    ? values
    : Array.from(
        { length: MAX_SAMPLES },
        (_, i) => values[Math.floor((i * values.length) / MAX_SAMPLES)],
      );

const send = (message: WorkerMessage) => process.send?.(message);

let clients: { spec: WorkerClientSpec; client: VuuPerfClient }[] = [];
let startedAt = 0;
let cpuAtStart = process.cpuUsage();

process.on(
  "message",
  async (message: { type: string } & Partial<WorkerInit>) => {
    if (message.type === "init") {
      const init = message as WorkerInit;
      const errors: string[] = [];
      const opened = await Promise.all(
        init.clients.map(async (spec) => {
          try {
            const client = await VuuPerfClient.login(init.wsUrl, spec.token, {
              insecure: init.insecure,
            });
            for (const vp of spec.viewports) await client.createViewport(vp);
            return { spec, client };
          } catch (error) {
            errors.push(`${spec.id}: ${(error as Error).message}`);
            return undefined;
          }
        }),
      );
      clients = opened.filter((c) => c !== undefined);
      send({ type: "ready", errors });
    } else if (message.type === "start") {
      startedAt = performance.now();
      cpuAtStart = process.cpuUsage();
      for (const { client } of clients) client.counting = true;
    } else if (message.type === "stop") {
      for (const { client } of clients) client.counting = false;
      const cpu = process.cpuUsage(cpuAtStart);
      send({
        type: "result",
        elapsedMs: performance.now() - startedAt,
        cpuMs: (cpu.user + cpu.system) / 1_000,
        clients: clients.map(({ spec, client }) => ({
          id: spec.id,
          messages: client.messages,
          bytes: client.bytes,
          wireLatency: sample(client.wireLatency.values),
          closed: client.closed,
          viewports: [...client.viewports.values()].map((counters) => ({
            kind: counters.spec.kind,
            rows: counters.rows,
            sizeOnly: counters.sizeOnly,
            seqGaps: counters.seqGaps,
            seqUpdates: counters.seqUpdates,
            latency: sample(counters.latency.values),
          })),
        })),
      });
    } else if (message.type === "exit") {
      for (const { client } of clients) client.close();
      setTimeout(() => process.exit(0), 100);
    }
  },
);
