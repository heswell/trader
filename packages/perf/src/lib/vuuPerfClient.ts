/**
 * Lean Vuu websocket client for load tests. Modelled on the test client
 * (packages/oms/__tests__/vuuClient.ts) but keeps no row cache: it only
 * counts rows / bytes and samples latencies per viewport, and answers server
 * heartbeats so long runs are not disconnected.
 */
import type {
  VuuServerMessage,
  VuuViewportCreateSuccessResponse,
} from "@vuu-ui/vuu-protocol-types";

type Body = VuuServerMessage["body"];

export interface ViewportSpec {
  /** Label in reports (e.g. "ladder"). */
  kind: string;
  module: string;
  table: string;
  columns: string[];
  filter?: string;
  range: { from: number; to: number };
  sort?: { column: string; sortType: "A" | "D" }[];
  /** Column holding the publish time (epoch ms), for end-to-end latency. */
  timestampColumn?: string;
  /** Column holding a per-row sequence number, for coalescing (seq gaps). */
  seqColumn?: string;
}

/** Bounded uniform sample (reservoir) of a numeric stream. */
export class Reservoir {
  readonly values: number[] = [];
  seen = 0;
  constructor(readonly capacity = 20_000) {}
  add(value: number) {
    this.seen++;
    if (this.values.length < this.capacity) this.values.push(value);
    else {
      const i = Math.floor(Math.random() * this.seen);
      if (i < this.capacity) this.values[i] = value;
    }
  }
}

export class ViewportCounters {
  rows = 0;
  sizeOnly = 0;
  /** Sequence numbers skipped between consecutive updates of a row. */
  seqGaps = 0;
  seqUpdates = 0;
  readonly latency = new Reservoir();
  readonly #lastSeq = new Map<string, number>();
  readonly #tsIdx: number;
  readonly #seqIdx: number;
  constructor(readonly spec: ViewportSpec) {
    this.#tsIdx = spec.timestampColumn
      ? spec.columns.indexOf(spec.timestampColumn)
      : -1;
    this.#seqIdx = spec.seqColumn ? spec.columns.indexOf(spec.seqColumn) : -1;
  }
  row(rowKey: string, data: unknown[], now: number) {
    this.rows++;
    if (this.#tsIdx !== -1) {
      const ts = data[this.#tsIdx];
      if (typeof ts === "number" && ts > 0) this.latency.add(now - ts);
    }
    if (this.#seqIdx !== -1) {
      const seq = data[this.#seqIdx];
      if (typeof seq === "number") {
        const last = this.#lastSeq.get(rowKey);
        if (last !== undefined && seq > last) {
          this.seqUpdates++;
          this.seqGaps += seq - last - 1;
        }
        this.#lastSeq.set(rowKey, seq);
      }
    }
  }
}

export interface ConnectOptions {
  /** Accept self-signed certificates (wss to the local stack). */
  insecure?: boolean;
}

export class VuuPerfClient {
  #requestId = 0;
  readonly viewports = new Map<string, ViewportCounters>();
  #listeners = new Set<(body: Body) => void>();
  /** Counting is on only inside the measurement window. */
  counting = false;
  messages = 0;
  bytes = 0;
  heartbeats = 0;
  /** Server send (TABLE_ROW timeStamp) to receipt, ms. */
  readonly wireLatency = new Reservoir();
  closed?: { code: number; reason: string };

  private constructor(
    readonly socket: WebSocket,
    readonly sessionId: string,
  ) {
    socket.addEventListener("close", ({ code, reason }) => {
      this.closed = { code, reason };
    });
    socket.addEventListener("message", ({ data }) => {
      const text = String(data);
      const message = JSON.parse(text) as VuuServerMessage;
      const { body } = message;
      if (body.type === "HB") {
        this.heartbeats++;
        this.send("CORE", { type: "HB_RESP", ts: Date.now() });
      } else if (body.type === "TABLE_ROW" && this.counting) {
        const now = Date.now();
        this.messages++;
        this.bytes += text.length;
        const sentAt = (body as { timeStamp?: number }).timeStamp;
        if (typeof sentAt === "number") this.wireLatency.add(now - sentAt);
        for (const row of body.rows) {
          const counters = this.viewports.get(row.viewPortId);
          if (!counters) continue;
          if (row.updateType === "U") counters.row(row.rowKey, row.data, now);
          else counters.sizeOnly++;
        }
      }
      for (const listener of this.#listeners) listener(body);
    });
  }

  static async fetchToken(
    authUrl: string,
    init: { username?: string; bearer?: string },
    options: ConnectOptions = {},
  ) {
    const response = await fetch(authUrl, {
      method: "POST",
      headers: init.bearer
        ? { Authorization: `Bearer ${init.bearer}` }
        : { "Content-Type": "application/json" },
      body: init.bearer
        ? undefined
        : JSON.stringify({ username: init.username, password: "password" }),
      tls: { rejectUnauthorized: !options.insecure },
    });
    if (!response.ok) {
      throw Error(`Vuu auth failed: HTTP ${response.status} ${authUrl}`);
    }
    return ((await response.json()) as { token: string }).token;
  }

  static async login(url: string, token: string, options: ConnectOptions = {}) {
    const socket = new WebSocket(url, {
      tls: { rejectUnauthorized: !options.insecure },
    } as never);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(Error(`WebSocket ${url} failed`)),
      );
    });
    const sessionId = new Promise<string>((resolve, reject) => {
      const onClose = ({ code, reason }: CloseEvent) =>
        reject(Error(`login closed ${code}: ${reason}`));
      const listener = ({ data }: MessageEvent) => {
        const message = JSON.parse(String(data)) as VuuServerMessage;
        if (message.body.type === "LOGIN_SUCCESS") {
          socket.removeEventListener("message", listener);
          socket.removeEventListener("close", onClose);
          resolve(message.sessionId ?? "");
        } else if ((message.body.type as string) === "LOGIN_FAIL") {
          reject(Error(`login failed: ${JSON.stringify(message.body)}`));
        }
      };
      socket.addEventListener("message", listener);
      socket.addEventListener("close", onClose);
    });
    socket.send(
      JSON.stringify({
        body: { token, type: "LOGIN" },
        module: "CORE",
        requestId: "login",
        sessionId: "",
      }),
    );
    return new VuuPerfClient(socket, await sessionId);
  }

  close() {
    this.socket.close();
  }

  /** Observe every server message body; returns an unsubscribe. */
  listen(listener: (body: Body) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(module: string, body: Record<string, unknown>) {
    const requestId = `r${++this.#requestId}`;
    this.socket.send(
      JSON.stringify({ body, module, requestId, sessionId: this.sessionId }),
    );
    return requestId;
  }

  waitFor<T extends Body>(matches: (body: Body) => boolean, ms = 10_000) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(Error("timed out waiting for message"));
      }, ms);
      const listener = (body: Body) => {
        if (!matches(body)) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(body as T);
      };
      this.#listeners.add(listener);
    });
  }

  /** Column names of a table (GET_TABLE_META). */
  async tableColumns(module: string, table: string) {
    const meta = this.waitFor<Body & { columns: string[] }>(
      (body) =>
        body.type === "TABLE_META_RESP" &&
        (body as { table: { table: string } }).table.table === table,
    );
    this.send(module, { table: { module, table }, type: "GET_TABLE_META" });
    return (await meta).columns;
  }

  async createViewport(spec: ViewportSpec) {
    const { module, table } = spec;
    const created = this.waitFor<VuuViewportCreateSuccessResponse>(
      (body) =>
        (body.type === "CREATE_VP_SUCCESS" ||
          body.type === "CREATE_VP_REJECT") &&
        (body as VuuViewportCreateSuccessResponse).table === table,
    );
    this.send(module, {
      aggregations: [],
      columns: spec.columns,
      filterSpec: { filter: spec.filter ?? "" },
      groupBy: [],
      range: spec.range,
      sort: { sortDefs: spec.sort ?? [] },
      table: { module, table },
      type: "CREATE_VP",
    });
    const response = await created;
    if (response.type !== "CREATE_VP_SUCCESS") {
      throw Error(`CREATE_VP ${table} rejected: ${JSON.stringify(response)}`);
    }
    this.viewports.set(response.viewPortId, new ViewportCounters(spec));
    return response.viewPortId;
  }
}
