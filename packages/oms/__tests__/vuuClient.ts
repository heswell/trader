import type {
  VuuRpcServiceResponse,
  VuuServerMessage,
  VuuViewportCreateSuccessResponse,
} from "@vuu-ui/vuu-protocol-types";

type Body = VuuServerMessage["body"];
export type Row = Record<string, unknown>;

/** Minimal Vuu websocket client for tests: login, viewports, RPCs, row cache. */
export class VuuClient {
  #requestId = 0;
  /** Latest row (by key) per viewport. */
  readonly rows = new Map<string, Map<string, Row>>();
  #columns = new Map<string, string[]>();
  #listeners = new Set<(body: Body) => void>();

  private constructor(
    readonly socket: WebSocket,
    readonly sessionId: string,
  ) {
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data)) as VuuServerMessage;
      const { body } = message;
      if (body.type === "TABLE_ROW") {
        for (const row of body.rows) {
          const columns = this.#columns.get(row.viewPortId);
          if (!columns || row.updateType !== "U") continue;
          const byKey = this.rows.get(row.viewPortId) ?? new Map();
          this.rows.set(row.viewPortId, byKey);
          byKey.set(
            row.rowKey,
            Object.fromEntries(columns.map((c, i) => [c, row.data[i]])),
          );
        }
      }
      for (const listener of this.#listeners) listener(body);
    });
  }

  /** POST credentials to the REST auth endpoint (plain HTTP in tests) for a token. */
  static async fetchToken(authUrl: string, username: string) {
    const response = await fetch(authUrl, {
      body: JSON.stringify({ username }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw Error(`login failed: HTTP ${response.status}`);
    return ((await response.json()) as { token: string }).token;
  }

  static async login(url: string, token: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(Error("WebSocket failed")));
    });
    const sessionId = new Promise<string>((resolve, reject) => {
      const onClose = ({ code, reason }: CloseEvent) =>
        reject(Error(`login closed ${code}: ${reason}`));
      const listener = ({ data }: MessageEvent) => {
        let message: VuuServerMessage;
        try {
          message = JSON.parse(String(data)) as VuuServerMessage;
        } catch {
          return;
        }
        if (message.body.type === "LOGIN_SUCCESS") {
          socket.removeEventListener("message", listener);
          socket.removeEventListener("close", onClose);
          resolve(message.sessionId ?? "");
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
    return new VuuClient(socket, await sessionId);
  }

  close() {
    this.socket.close();
  }

  send(module: string, body: Record<string, unknown>) {
    this.socket.send(
      JSON.stringify({
        body,
        module,
        requestId: `r${++this.#requestId}`,
        sessionId: this.sessionId,
      }),
    );
  }

  waitFor<T extends Body>(matches: (body: Body) => boolean, ms = 5_000) {
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

  async createViewport(module: string, table: string, columns: string[]) {
    const created = this.waitFor<VuuViewportCreateSuccessResponse>(
      (body) =>
        body.type === "CREATE_VP_SUCCESS" &&
        (body as VuuViewportCreateSuccessResponse).table === table,
    );
    this.send(module, {
      aggregations: [],
      columns,
      filterSpec: { filter: "" },
      groupBy: [],
      range: { from: 0, to: 100 },
      sort: { sortDefs: [] },
      table: { module, table },
      type: "CREATE_VP",
    });
    const { viewPortId } = await created;
    this.#columns.set(viewPortId, columns);
    return viewPortId;
  }

  async rpc(
    module: string,
    viewPortId: string,
    rpcName: string,
    params: Record<string, unknown>,
  ) {
    const response = this.waitFor<VuuRpcServiceResponse>(
      (body) =>
        body.type === "RPC_RESPONSE" && (body.rpcName as string) === rpcName,
    );
    this.send(module, {
      context: { type: "VIEWPORT_CONTEXT", viewPortId },
      params,
      rpcName,
      type: "RPC_REQUEST",
    });
    return (await response).result as {
      type: string;
      data?: Record<string, unknown>;
      errorMessage?: string;
    };
  }

  /** Current rows of a viewport. */
  rowsOf(viewPortId: string) {
    return [...(this.rows.get(viewPortId)?.values() ?? [])];
  }

  /** Wait until a row matching the predicate is in the viewport. */
  async row(viewPortId: string, matches: (row: Row) => boolean, ms = 5_000) {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.rowsOf(viewPortId).find(matches);
      if (found) return found;
      if (Date.now() > until) {
        throw Error(
          `no matching row in ${viewPortId}: ${JSON.stringify(this.rowsOf(viewPortId))}`,
        );
      }
      await Bun.sleep(20);
    }
  }
}
