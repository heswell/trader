import { Side } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import type { LadderQueue } from "../../hooks/useBookQueue";
import type { DepthLevel } from "../../hooks/useMarketData";
import {
  type OrderBookChildOrder,
  type OrderBookState,
  useOrderBook,
} from "../../hooks/useOrderBook";
import {
  OWN_ORDER_STATUSES,
  ownOrdersKey,
} from "../../hooks/useOwnWorkingOrders";
import { formatPrice, formatQuantity } from "../../utils/formatting";
import { queueSegments } from "../PriceLadder/PriceLadderView";

import orderBookViewCss from "./OrderBookView.css";

const classBase = "tradingOrderBookView";

/** One price level on one side of the book. */
export interface BookLevelRef {
  side: Side;
  price: number;
}

export interface OrderBookViewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Parent order (OMS `parentOrders.orderId`) to show the book for. */
  orderId?: string;
  /** L2 levels per side. Default 10. */
  levels?: number;
  /**
   * The level whose L3 queue is shown. Controlled with `onLevelChange`;
   * when undefined the view picks the level of the order's best-placed
   * working child order, else the best price on the order's side.
   */
  level?: BookLevelRef;
  onLevelChange?: (level: BookLevelRef) => void;
}

const MAX_QUEUE_ROWS = 100;

const orderCount = (n: number) => `${n} order${n === 1 ? "" : "s"}`;

const sideText = (side: Side) => (side === Side.Buy ? "Bid" : "Ask");

const sameLevel = (a: BookLevelRef | undefined, b: BookLevelRef) =>
  a !== undefined && a.side === b.side && a.price === b.price;

/** 42s, 3m 05s, 1h 02m. */
const ageText = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/** The book side an order of `side` rests on: buys on the bid. */
const restingSide = (side: Side) => (side === Side.Buy ? Side.Buy : Side.Sell);

/** A level to open with: the best-placed working child, else the touch. */
const defaultLevel = (book: OrderBookState): BookLevelRef | undefined => {
  const placed = book.children
    .filter((c) => c.position)
    .sort(
      (a, b) =>
        (a.position?.ahead ?? 0) - (b.position?.ahead ?? 0) ||
        (a.position?.rank ?? 0) - (b.position?.rank ?? 0),
    )[0];
  if (placed?.position) {
    const { side, price } = placed.position.queue;
    return { side, price };
  }
  const order = book.order;
  if (!order) return undefined;
  const side = restingSide(order.side);
  const best = side === Side.Buy ? book.depth.bids[0] : book.depth.asks[0];
  return best ? { side, price: best.price } : undefined;
};

const useNow = (enabled: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
};

/**
 * The book a parent order is working in, read top down: the order and its
 * resting child orders, the instrument's L2 depth with the levels holding
 * the order marked, and the L3 queue at one level (front first) with the
 * order's position in it. Click a level or a child order to see its queue.
 * Made for the shell context panel beside the order blotter.
 */
export const OrderBookView = forwardRef<HTMLDivElement, OrderBookViewProps>(
  function OrderBookView(
    {
      className,
      level: levelProp,
      levels = 10,
      onLevelChange,
      orderId,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-order-book-view",
      css: orderBookViewCss,
      window: targetWindow,
    });
    const book = useOrderBook(orderId, { levels });
    const [levelState, setLevelState] = useState<BookLevelRef>();
    // a new order starts from its own default level
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset on orderId only
    useEffect(() => setLevelState(undefined), [orderId]);
    const level = levelProp ?? levelState ?? defaultLevel(book);
    const pick = (next: BookLevelRef) => {
      setLevelState(next);
      onLevelChange?.(next);
    };
    const now = useNow(!!orderId);

    const { order, instrument, depth, queues } = book;
    const fmtPrice = (price: number) => formatPrice(price, instrument ?? {});

    if (!orderId) {
      return (
        <div {...htmlAttributes} className={cx(classBase, className)} ref={ref}>
          <p className={`${classBase}-message`}>
            Select an order to see its book
          </p>
        </div>
      );
    }
    if (!order) {
      return (
        <div {...htmlAttributes} className={cx(classBase, className)} ref={ref}>
          <p className={`${classBase}-message`}>
            {book.loaded ? `Order ${orderId} not found` : "Loading…"}
          </p>
        </div>
      );
    }

    const queue = level
      ? queues.get(ownOrdersKey(level.side, level.price))
      : undefined;
    const working = book.children.filter((c) => c.working);
    const resting = working.reduce((sum, c) => sum + c.leavesQty, 0);
    // only a working order has quantity still to send
    const unsent = OWN_ORDER_STATUSES.includes(order.status)
      ? Math.max(0, order.quantity - order.cumQty - resting)
      : 0;
    const placed = working.filter((c) => c.position);

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-order-book-view"
        ref={ref}
      >
        <nav aria-label="Drill path" className={`${classBase}-path`}>
          <span>{order.orderId}</span>
          <span aria-hidden="true">›</span>
          <span>
            L2 ·{" "}
            {level ? `${sideText(level.side)} ${fmtPrice(level.price)}` : "—"}
          </span>
          <span aria-hidden="true">›</span>
          <span className={`${classBase}-pathQueue`}>
            L3 ·{" "}
            {queue
              ? queue.ownRank !== undefined
                ? `#${queue.ownRank} of ${queue.orders.length}`
                : orderCount(queue.orders.length)
              : "no queue"}
          </span>
        </nav>

        <OrderSummary
          fmtPrice={fmtPrice}
          order={order}
          resting={resting}
          unsent={unsent}
        />

        <section
          aria-label="Resting child orders"
          className={`${classBase}-children`}
        >
          {placed.length > 0 ? (
            placed.map((child) => (
              <ChildChip
                child={child}
                fmtPrice={fmtPrice}
                key={child.childOrderId}
                onClick={pick}
                selected={
                  !!child.position && sameLevel(level, child.position.queue)
                }
              />
            ))
          ) : (
            <p className={`${classBase}-note`}>
              {working.length > 0
                ? "Working child orders are not in the book yet"
                : "Not resting: no working child orders"}
            </p>
          )}
        </section>

        <DepthLadder
          depth={depth}
          fmtPrice={fmtPrice}
          onPick={pick}
          queues={queues}
          selected={level}
        />

        {book.l3Available ? (
          <QueueSection
            fmtPrice={fmtPrice}
            level={level}
            now={now}
            queue={queue}
            truncated={book.l3Truncated}
            childOrders={book.children}
          />
        ) : depth.loaded && depth.bids.length + depth.asks.length > 0 ? (
          <output className={`${classBase}-note`}>
            Order-by-order data isn't enabled on this server
          </output>
        ) : null}
      </div>
    );
  },
);

const OrderSummary = ({
  fmtPrice,
  order,
  resting,
  unsent,
}: {
  fmtPrice: (price: number) => string;
  order: NonNullable<OrderBookState["order"]>;
  resting: number;
  unsent: number;
}) => {
  const pct = (qty: number) =>
    order.quantity > 0
      ? `${Math.min(100, (qty / order.quantity) * 100)}%`
      : "0%";
  const detail = [
    order.price !== undefined ? `Lmt ${fmtPrice(order.price)}` : order.ordType,
    order.strategy,
    order.timeInForce,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-label="Order" className={`${classBase}-order`}>
      <div className={`${classBase}-orderTitle`}>
        <span data-side={order.side}>{order.side}</span>
        <strong>
          {formatQuantity(order.quantity)} {order.ric}
        </strong>
        <span className={`${classBase}-secondary`}>{detail}</span>
      </div>
      <div aria-hidden="true" className={`${classBase}-progress`}>
        <span data-part="filled" style={{ width: pct(order.cumQty) }} />
        <span data-part="resting" style={{ width: pct(resting) }} />
      </div>
      <div className={`${classBase}-orderStats`}>
        <span>
          <strong>{formatQuantity(order.cumQty)}</strong> filled
          {order.avgPx !== undefined ? ` @ ${fmtPrice(order.avgPx)}` : ""}
        </span>
        <span>
          <strong>{formatQuantity(resting)}</strong> resting
        </span>
        {unsent > 0 ? (
          <span>
            <strong>{formatQuantity(unsent)}</strong> not yet sent
          </span>
        ) : null}
      </div>
    </section>
  );
};

const ChildChip = ({
  child,
  fmtPrice,
  onClick,
  selected,
}: {
  child: OrderBookChildOrder;
  fmtPrice: (price: number) => string;
  onClick: (level: BookLevelRef) => void;
  selected: boolean;
}) => {
  const position = child.position;
  if (!position) return null;
  const { side, price } = position.queue;
  return (
    <button
      aria-pressed={selected}
      className={`${classBase}-chip`}
      onClick={() => onClick({ side, price })}
      type="button"
    >
      <span className={`${classBase}-mono`}>{child.exchangeOrderId}</span>
      <strong>
        {formatQuantity(child.leavesQty)} @ {fmtPrice(price)}
      </strong>
      <span className={`${classBase}-secondary`}>
        #{position.rank} of {position.queue.orders.length} ·{" "}
        {formatQuantity(position.ahead)} ahead
      </span>
    </button>
  );
};

const DepthLadder = ({
  depth,
  fmtPrice,
  onPick,
  queues,
  selected,
}: {
  depth: OrderBookState["depth"];
  fmtPrice: (price: number) => string;
  onPick: (level: BookLevelRef) => void;
  queues: ReadonlyMap<string, LadderQueue>;
  selected: BookLevelRef | undefined;
}) => {
  const { bids, asks } = depth;
  const headingId = useId();
  const maxQty = Math.max(
    1,
    ...bids.map((l) => l.size),
    ...asks.map((l) => l.size),
  );
  const row = (side: Side, level: DepthLevel) => {
    const queue = queues.get(ownOrdersKey(side, level.price));
    const own = queue?.ownRank !== undefined;
    const isSelected = sameLevel(selected, { side, price: level.price });
    const bar = (
      <span
        aria-hidden="true"
        className={`${classBase}-bar`}
        style={{ width: `${(level.size / maxQty) * 100}%` }}
      />
    );
    const qty = formatQuantity(level.size);
    return (
      <button
        aria-label={`${sideText(side)} ${fmtPrice(level.price)}, ${qty} in ${level.orderCount} orders${own ? ", includes this order" : ""}. Show queue`}
        aria-pressed={isSelected}
        className={`${classBase}-level`}
        data-own={own || undefined}
        data-side={side}
        // Key by level, not price: depth rows tick one at a time, so two
        // levels can briefly share a price, and duplicate keys leave stale
        // rows behind.
        key={`${side}|${level.level}`}
        onClick={() => onPick({ side, price: level.price })}
        type="button"
      >
        <span className={`${classBase}-count`}>{level.orderCount}</span>
        <span className={`${classBase}-qty`} data-col="bid">
          {side === Side.Buy ? (
            <>
              {bar}
              <span>{qty}</span>
            </>
          ) : null}
        </span>
        <span className={`${classBase}-price`}>
          {own ? (
            <span aria-hidden="true" className={`${classBase}-ownDot`} />
          ) : null}
          {fmtPrice(level.price)}
        </span>
        <span className={`${classBase}-qty`} data-col="ask">
          {side === Side.Sell ? (
            <>
              {bar}
              <span>{qty}</span>
            </>
          ) : null}
        </span>
        <span aria-hidden="true" className={`${classBase}-segments`}>
          {queue ? (
            <span
              className={`${classBase}-segmentsFill`}
              style={{
                width: `${Math.min(100, (queue.total / maxQty) * 100)}%`,
              }}
            >
              {queueSegments(queue, maxQty).map((segment, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                  key={i}
                  data-own={segment.own || undefined}
                  style={{ flexGrow: segment.size }}
                />
              ))}
            </span>
          ) : null}
        </span>
      </button>
    );
  };
  return (
    <section aria-labelledby={headingId} className={`${classBase}-depth`}>
      <h3 className={`${classBase}-heading`} id={headingId}>
        Level 2 · Depth
      </h3>
      <div aria-hidden="true" className={`${classBase}-levelHeader`}>
        <span>#</span>
        <span>Bid</span>
        <span>Price</span>
        <span>Ask</span>
        <span>Queue (L3)</span>
      </div>
      {[...asks].reverse().map((level) => row(Side.Sell, level))}
      <div className={`${classBase}-spread`}>
        {bids[0] && asks[0]
          ? `Spread ${fmtPrice(asks[0].price - bids[0].price)}`
          : depth.loaded
            ? "No prices"
            : "Waiting for prices…"}
      </div>
      {bids.map((level) => row(Side.Buy, level))}
    </section>
  );
};

const QueueSection = ({
  childOrders,
  fmtPrice,
  level,
  now,
  queue,
  truncated,
}: {
  childOrders: readonly OrderBookChildOrder[];
  fmtPrice: (price: number) => string;
  level: BookLevelRef | undefined;
  now: number;
  queue: LadderQueue | undefined;
  truncated: boolean;
}) => {
  const childByExchangeId = useMemo(
    () =>
      new Map(
        childOrders
          .filter((c) => c.exchangeOrderId)
          .map((c) => [c.exchangeOrderId as string, c.childOrderId]),
      ),
    [childOrders],
  );
  if (!level) return null;
  const title = `Level 3 · Queue at ${sideText(level.side)} ${fmtPrice(level.price)}`;
  const orders = queue?.orders ?? [];
  const total = queue?.total ?? 0;
  const ownIndex = orders.findIndex((o) => o.own);
  const ownAhead = orders
    .slice(0, Math.max(0, ownIndex))
    .reduce((sum, o) => sum + o.size, 0);
  const ownSize = ownIndex >= 0 ? orders[ownIndex].size : 0;
  let ahead = 0;
  return (
    <section aria-label={title} className={`${classBase}-queue`}>
      <div className={`${classBase}-queueTitle`}>
        <h3 className={`${classBase}-heading`}>{title}</h3>
        <span className={`${classBase}-secondary`}>
          {orderCount(orders.length)} · {formatQuantity(total)}
        </span>
      </div>
      {orders.length > 0 ? (
        <>
          <div aria-hidden="true" className={`${classBase}-queueBar`}>
            {orders.map((o) => (
              <span
                data-own={o.own || undefined}
                key={o.orderId}
                style={{ flexGrow: o.size }}
              />
            ))}
          </div>
          <div aria-hidden="true" className={`${classBase}-queueEnds`}>
            <span>Front · next to trade</span>
            <span>Back · newest</span>
          </div>
        </>
      ) : null}
      {ownIndex >= 0 ? (
        <dl className={`${classBase}-stats`}>
          <div>
            <dt>Position</dt>
            <dd>
              #{ownIndex + 1} of {orders.length}
            </dd>
          </div>
          <div>
            <dt>Size ahead</dt>
            <dd>{formatQuantity(ownAhead)}</dd>
          </div>
          <div>
            <dt>Behind</dt>
            <dd>{formatQuantity(total - ownAhead - ownSize)}</dd>
          </div>
          <div>
            <dt>This order</dt>
            <dd>{formatQuantity(ownSize)}</dd>
          </div>
        </dl>
      ) : (
        <p className={`${classBase}-note`}>
          {orders.length === 0
            ? "No resting orders at this level"
            : "This order has nothing resting at this level"}
        </p>
      )}
      {orders.length > 0 ? (
        <table className={`${classBase}-queueTable`}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Exchange id</th>
              <th scope="col">Size</th>
              <th scope="col">Ahead</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, MAX_QUEUE_ROWS).map((o, i) => {
              const child = o.own
                ? childByExchangeId.get(o.orderId)
                : undefined;
              const row = (
                <tr data-own={o.own || undefined} key={o.orderId}>
                  <td>{i + 1}</td>
                  <td>
                    <span className={`${classBase}-mono`}>{o.orderId}</span>
                    {o.own ? (
                      <span className={`${classBase}-mine`}>
                        {child ? `Yours · ${child}` : "Yours"}
                      </span>
                    ) : null}
                  </td>
                  <td>{formatQuantity(o.size)}</td>
                  <td>{i === 0 ? "—" : formatQuantity(ahead)}</td>
                  <td>{ageText(now - o.entryTime)}</td>
                </tr>
              );
              ahead += o.size;
              return row;
            })}
          </tbody>
        </table>
      ) : null}
      {orders.length > MAX_QUEUE_ROWS ? (
        <p className={`${classBase}-note`}>
          {orders.length - MAX_QUEUE_ROWS} more
        </p>
      ) : null}
      {truncated ? (
        <output className={`${classBase}-note`}>
          This instrument has more resting orders than were loaded; queues may
          be incomplete
        </output>
      ) : null}
    </section>
  );
};
