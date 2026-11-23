# @heswell/book-model

The order-by-order (L3) book of one instrument, rebuilt from the exchange simulator's `bookOrders` snapshot and
`bookEvents` tape (see the [exchange-sim README](../exchange-sim/README.md)). It is anonymous, and has no UI or
transport dependencies: only `@heswell/trading-schemas` enums. The UI hooks (`useBookQueue`, `useOrderBook`) and the
exchange-sim replay test both use it.

| Export | What |
| --- | --- |
| `BookBuilder` | Resting orders, the queue at each price and each order's place in it |
| `queuePosition(level, orderId)` | 1-based rank and size ahead of an order in a level |
| `BookOrder`, `BookEvent`, `Level`, `OrderPosition`, `BookChange`, `BookStatus` | Plain data types |

```ts
const book = new BookBuilder();
book.reset(bookOrderRows, snapshotSeq); // diffed: unchanged levels keep their objects
book.apply(bookEventRows);              // "ok", or "gap": out of sequence or inconsistent, reset to resync
book.levels(Side.Buy, 10);              // best first
book.order(orderId);                    // { order, level, rank, ahead }
const unsubscribe = book.subscribe(({ levels, removed, orderIds }) => {});
```

## Rules

- **Queue order** follows the exchange. Snapshot orders are ordered by `priority`. An ADD joins the back of its
  level. EXECUTE and REDUCE keep the order's place. An amend that loses priority arrives as DELETE then ADD.
- **Stable objects.** A `Level` object, and the array `levels()` returns, are replaced only when they change, so React
  memoisation can compare them by identity. `BookOrder` objects are never mutated.
- **Sequence.** `apply` needs a `live` book. It skips events at or before `seq`, and stops at the first event that
  is not `seq + 1` or does not match the book (unknown order, wrong price, sizes that don't add up). The book is
  then `stale` until the next `reset`.
- **Snapshot-only feed.** A client that only subscribes to `bookOrders` calls `reset` with every update. The diff
  keeps unchanged levels, so it costs what the changes cost, plus one pass over the rows.

The event feed (snapshot marker, RESET event, gap recovery from a Vuu viewport) is planned, not built: see the
book model plan.
