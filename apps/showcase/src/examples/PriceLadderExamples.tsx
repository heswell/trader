import { Side, tickScheduleOf } from "@heswell/trading-schemas";
import {
  type LadderLevel,
  MarketDepth,
  type OwnOrder,
  type OwnOrdersAtPrice,
  ownOrdersKey,
  PriceLadder,
  type PriceLadderOrderEvent,
  PriceLadderView,
  priceKey,
  type TradingRpcError,
} from "@heswell/trading-ui";
import { Button, Checkbox, FlexLayout, Text } from "@salt-ds/core";
import {
  Profiler,
  type ProfilerOnRenderCallback,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { InstrumentSelector } from "./shared/InstrumentSelector";

const ACCOUNT = "ACC-US-01";

const describeEvent = (e: PriceLadderOrderEvent) => {
  switch (e.type) {
    case "create":
      return `${e.response.orderId} ${e.request.side} ${e.request.quantity} @ ${e.request.price} ${e.response.status}`;
    case "amend":
      return `${e.order.orderId} amended to ${e.price} ${e.response.status}`;
    case "cancel":
      return `${e.order.orderId} cancel ${e.response.status}`;
    case "cancelAll":
      return `cancelAll ${e.ric}: ${e.response.orderIds.length} order(s)`;
  }
};

/**
 * Live PriceLadder (account ACC-US-01) following the selected instrument,
 * next to its MarketDepth, with an order event / error log.
 */
export const PriceLadderLive = () => {
  const [log, setLog] = useState<string[]>([]);
  const [showVolume, setShowVolume] = useState(true);
  const add = (line: string) =>
    setLog((l) =>
      [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 50),
    );
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        gridTemplateColumns:
          "minmax(320px, 0.8fr) minmax(420px, 1fr) minmax(360px, 1fr)",
        gridTemplateRows: "1fr auto 160px",
        height: "100%",
      }}
    >
      <div style={{ gridRow: "1 / span 3", minHeight: 0 }}>
        <InstrumentSelector showAdmin />
      </div>
      <PriceLadder
        account={ACCOUNT}
        showVolume={showVolume}
        defaultQuantity={100}
        onOrderEvent={(e) => add(describeEvent(e))}
        onError={(err: TradingRpcError, action) =>
          add(`${action.type} failed: ${err.reason}: ${err.text}`)
        }
        style={{
          border: "1px solid var(--salt-separable-tertiary-borderColor)",
          gridRow: "1 / span 2",
          minHeight: 0,
        }}
      />
      <div style={{ minHeight: 0, overflow: "auto" }}>
        <MarketDepth account={ACCOUNT} />
      </div>
      <Checkbox
        label="Traded volume column"
        checked={showVolume}
        onChange={(e) => setShowVolume(e.target.checked)}
      />
      <pre
        style={{
          gridColumn: "2 / span 2",
          margin: 0,
          overflow: "auto",
          fontSize: 12,
        }}
      >
        {log.join("\n")}
      </pre>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Stress / performance example
// ---------------------------------------------------------------------------

const schedule = tickScheduleOf({ tickSize: 0.01 });
const LEVELS = 10;

interface Book {
  mid: number;
  bids: LadderLevel[];
  asks: LadderLevel[];
  last: number;
}

/** Deterministic PRNG (mulberry32) so runs are comparable. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const round = (p: number) => Math.round(p * 100) / 100;

const makeBook = (mid: number, random: () => number, last: number): Book => {
  const bestBid = round(mid - 0.01);
  const bestAsk = round(mid + 0.01);
  const size = () => 100 * (1 + Math.floor(random() * 50));
  return {
    mid,
    last,
    bids: Array.from({ length: LEVELS }, (_, i) => ({
      price: round(bestBid - i * 0.01),
      size: size(),
    })),
    asks: Array.from({ length: LEVELS }, (_, i) => ({
      price: round(bestAsk + i * 0.01),
      size: size(),
    })),
  };
};

interface PerfStats {
  updatesPerSec: number;
  commitsPerSec: number;
  fps: number;
  minFps: number;
  renderAvgMs: number;
  renderP95Ms: number;
  renderMaxMs: number;
  /** Book update (setState) to the ladder's committed DOM (layout effect). */
  commitP95Ms: number;
  /** Book update to the start of the next frame (rAF after the commit). */
  frameP95Ms: number;
  longFrames: number;
}

/** ?rate=100&autorun=1 sets the update rate and runs the benchmark (packages/perf). */
const stressParams = () => {
  const params = new URLSearchParams(window.location.search);
  const rate = Number(params.get("rate"));
  return {
    rate: rate > 0 ? rate : 50,
    autorun: params.get("autorun") === "1",
    seconds: Number(params.get("seconds")) || 10,
  };
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/**
 * PriceLadderView driven by a synthetic book at a configurable update rate
 * (default 50 updates/s, each moving sizes on several levels and sometimes
 * the mid), with React Profiler commit timings and a requestAnimationFrame
 * FPS meter. Press "Run 10s benchmark" for a summary (also exposed as JSON
 * in `[data-testid=price-ladder-perf-result]` for automated runs).
 */
export const PriceLadderStress = () => {
  const [params] = useState(stressParams);
  const [rate, setRate] = useState(params.rate);
  const [running, setRunning] = useState(true);
  const [book, setBook] = useState<Book>(() => makeBook(100, rng(1), 100));
  const [stats, setStats] = useState<PerfStats>();
  const [result, setResult] = useState<string>("");
  const renders = useRef<number[]>([]);
  const updates = useRef(0);
  const frames = useRef<number[]>([]);
  const updatedAt = useRef<number>(undefined);
  const commitLatency = useRef<number[]>([]);
  const frameLatency = useRef<number[]>([]);
  /** Raw samples while a benchmark runs, for whole-run percentiles. */
  const samples = useRef<{ render: number[]; commit: number[] }>(undefined);

  // synthetic market
  useEffect(() => {
    if (!running) return;
    const random = rng(42);
    const id = setInterval(() => {
      updates.current += 1;
      // first update since the last commit: later ones coalesce into it
      updatedAt.current ??= performance.now();
      setBook((b) => {
        let mid = b.mid;
        let last = b.last;
        if (random() < 0.1) mid = round(mid + (random() < 0.5 ? -0.01 : 0.01));
        if (random() < 0.3) last = round(mid + (random() < 0.5 ? -0.01 : 0.01));
        if (mid !== b.mid) return makeBook(mid, random, last);
        const bids = b.bids.slice();
        const asks = b.asks.slice();
        for (let i = 0; i < 4; i++) {
          const side = random() < 0.5 ? bids : asks;
          const level = Math.floor(random() * LEVELS);
          side[level] = {
            ...side[level],
            size: 100 * (1 + Math.floor(random() * 50)),
          };
        }
        return { mid, last, bids, asks };
      });
    }, 1000 / rate);
    return () => clearInterval(id);
  }, [rate, running]);

  // update -> commit / next frame latency
  useLayoutEffect(() => {
    void book;
    const since = updatedAt.current;
    if (since === undefined) return;
    updatedAt.current = undefined;
    const committed = performance.now();
    commitLatency.current.push(committed - since);
    requestAnimationFrame((frame) => {
      frameLatency.current.push(Math.max(0, frame - since));
    });
  }, [book]);

  // FPS meter + 1s stats
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      frames.current.push(now - prev);
      prev = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let lastUpdates = 0;
    const id = setInterval(() => {
      const f = frames.current.splice(0);
      const r = renders.current.splice(0);
      const c = commitLatency.current.splice(0);
      const fl = frameLatency.current.splice(0);
      if (samples.current) {
        samples.current.render.push(...r);
        samples.current.commit.push(...c);
      }
      const u = updates.current - lastUpdates;
      lastUpdates = updates.current;
      setStats({
        updatesPerSec: u,
        commitsPerSec: r.length,
        fps: f.length,
        minFps: f.length ? Math.round(1000 / Math.max(...f)) : 0,
        renderAvgMs: r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0,
        renderP95Ms: percentile(r, 0.95),
        renderMaxMs: r.length ? Math.max(...r) : 0,
        commitP95Ms: percentile(c, 0.95),
        frameP95Ms: percentile(fl, 0.95),
        longFrames: f.filter((d) => d > 1000 / 30).length,
      });
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  const history = useRef<PerfStats[]>([]);
  useEffect(() => {
    if (stats) history.current.push(stats);
  }, [stats]);
  const benchmark = useCallback(() => {
    setResult("running…");
    history.current = [];
    samples.current = undefined;
    // skip the partial first second
    setTimeout(() => {
      history.current = [];
      samples.current = { render: [], commit: [] };
    }, 1_000);
    setTimeout(
      () => {
        const h = history.current;
        const all = samples.current ?? { render: [], commit: [] };
        samples.current = undefined;
        const ms = (value: number) => Math.round(value * 100) / 100;
        const avg = (k: keyof PerfStats) =>
          h.reduce((a, s) => a + s[k], 0) / Math.max(1, h.length);
        const summary = {
          seconds: h.length,
          targetUpdatesPerSec: rate,
          updatesPerSec: Math.round(avg("updatesPerSec")),
          fps: Math.round(avg("fps") * 10) / 10,
          minFps: Math.min(...h.map((s) => s.minFps)),
          renderAvgMs: Math.round(avg("renderAvgMs") * 100) / 100,
          renderP95Ms: ms(percentile(all.render, 0.95)),
          renderMaxMs: ms(Math.max(0, ...all.render)),
          commitP95Ms: ms(percentile(all.commit, 0.95)),
          commitMaxMs: ms(Math.max(0, ...all.commit)),
          /** Worst 1s window. */
          frameP95Ms: ms(Math.max(...h.map((s) => s.frameP95Ms))),
          longFrames: h.reduce((a, s) => a + s.longFrames, 0),
        };
        setResult(JSON.stringify(summary));
      },
      (params.seconds + 1) * 1_000,
    );
  }, [rate, params.seconds]);

  useEffect(() => {
    if (!params.autorun) return;
    const id = setTimeout(benchmark, 2_000);
    return () => clearTimeout(id);
  }, [params.autorun, benchmark]);

  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration) => {
      renders.current.push(actualDuration);
    },
    [],
  );

  const ownOrders = useMemo(() => {
    const map = new Map<string, OwnOrdersAtPrice>();
    const order = (side: Side, price: number, qty: number): OwnOrder => ({
      orderId: `S-${side}-${price}`,
      clOrdId: "stress",
      account: ACCOUNT,
      ric: "STRESS",
      side,
      price,
      quantity: qty,
      leavesQty: qty,
      cumQty: 0,
      status: "NEW",
    });
    for (const o of [
      order(Side.Buy, 99.95, 500),
      order(Side.Sell, 100.06, 300),
    ]) {
      map.set(ownOrdersKey(o.side, o.price), {
        side: o.side,
        price: o.price,
        quantity: o.leavesQty,
        orders: [o],
      });
    }
    return map;
  }, []);
  const volume = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = -5; i <= 5; i++)
      map.set(priceKey(round(100 + i * 0.01)), 1000 + i * 100);
    return map;
  }, []);

  return (
    <FlexLayout direction="column" gap={1} style={{ height: "100%" }}>
      <FlexLayout align="center" gap={1} wrap>
        <Text>Updates/s:</Text>
        {[10, 50, 100, 200].map((r) => (
          <Button
            key={r}
            appearance={r === rate ? "solid" : "bordered"}
            onClick={() => setRate(r)}
          >
            {r}
          </Button>
        ))}
        <Checkbox
          label="Running"
          checked={running}
          onChange={(e) => setRunning(e.target.checked)}
        />
        <Button onClick={benchmark}>Run {params.seconds}s benchmark</Button>
        <Text data-testid="price-ladder-perf-live">
          {stats
            ? `${stats.updatesPerSec} upd/s · ${stats.commitsPerSec} commits/s · ${stats.fps} fps (min ${stats.minFps}) · render avg ${stats.renderAvgMs.toFixed(2)}ms p95 ${stats.renderP95Ms.toFixed(2)}ms max ${stats.renderMaxMs.toFixed(2)}ms · update→commit p95 ${stats.commitP95Ms.toFixed(1)}ms`
            : "measuring…"}
        </Text>
      </FlexLayout>
      <pre data-testid="price-ladder-perf-result" style={{ margin: 0 }}>
        {result}
      </pre>
      <div style={{ display: "flex", flex: 1, gap: 8, minHeight: 0 }}>
        {/* biome-ignore lint/correctness/useUniqueElementIds: Profiler id is not a DOM id */}
        <Profiler id="price-ladder" onRender={onRender}>
          <PriceLadderView
            ric="STRESS"
            tickSchedule={schedule}
            priceFormat={{ priceDecimals: 2, tickSize: 0.01 }}
            bids={book.bids}
            asks={book.asks}
            last={book.last}
            ownOrders={ownOrders}
            tradedVolume={volume}
            showVolume
            onTrade={() => undefined}
            onCancelOrders={() => undefined}
            onAmendOrders={() => undefined}
            style={{
              border: "1px solid var(--salt-separable-tertiary-borderColor)",
              flex: "0 0 520px",
            }}
          />
        </Profiler>
      </div>
    </FlexLayout>
  );
};
