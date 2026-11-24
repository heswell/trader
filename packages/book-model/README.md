# @heswell/book-model

The order-by-order (L3) book of one instrument, rebuilt from the exchange simulator's `bookOrders` snapshot and
`bookEvents` tape (see the [exchange-sim README](../exchange-sim/README.md)). It is anonymous, and has no UI or
transport dependencies: only `@heswell/trading-schemas` enums. The UI hooks (`useBookQueue`, `useOrderBook`) and the
exchange-sim replay test both use it.

| Export | What |
| --- | --- |
| `BookBuilder` | Resting orders, the queue at each price and each order's place in it |
| `queuePosition(level, orderId)` | 1-based rank and size ahead of an order in a level |
| `BookFeed` | Keeps a `BookBuilder` in step with `bookOrders`, `bookStatus` and windows of `bookEvents`, as Vuu viewports deliver them |
| `QueueActivity` | Fills and cancels ahead of a tracked order (`book.track(orderId)`, `book.activity(orderId)`) |
| `BookOrder`, `BookEvent`, `Level`, `OrderPosition`, `BookChange`, `BookStatus` | Plain data types |

```ts
const book = new BookBuilder();
book.reset(bookOrderRows, snapshotSeq); // diffed: unchanged levels keep their objects
book.apply(bookEventRows);              // "ok"; "gap" (out of sequence, inconsistent) or "reset" (RESET event): resync
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
  is not `seq + 1` or does not match the book (unknown order, wrong price, sizes that don't add up), returning
  `"gap"`, or at a `RESET` (the exchange replaced the book), returning `"reset"`. The book is then `stale` until the
  next `reset`.
- **Snapshot marker.** `reset(rows, seq)` takes the `bookStatus.seq` of the instrument as the snapshot's seq, so
  `apply` replays only the events after it.
- **Snapshot-only feed.** A client that only subscribes to `bookOrders` calls `reset` with every update. The diff
  keeps unchanged levels, so it costs what the changes cost, plus one pass over the rows.

## Following the tape: `BookFeed`

```ts
const feed = new BookFeed();
feed.events(bookEventRows);        // any window of the tape: any order, overlaps are fine
feed.snapshot(bookOrderRows, statusRow); // rows with their seq, and the instrument's bookStatus row
feed.source;                       // "waiting" | "events" | "snapshot" (no events seen: the tape is off)
feed.book.track(exchangeOrderId);  // then feed.book.activity(exchangeOrderId)
```

- Events are buffered by seq and applied once a snapshot is loaded.
- A snapshot is used only when it is consistent with its marker: as many rows as `orders`, none newer than `seq`.
  The rows and the marker come from separate viewports, so either can be ahead of the other.
- On a gap or a `RESET`, the book waits for the next consistent snapshot and replays the buffer after its marker.
- While live, a snapshot at the book's seq is compared with it; two mismatches in a row reload it. Snapshots ahead
  of a book that isn't moving get `behindGrace` (4) snapshots' grace for its events to arrive, then the next is
  loaded (at once when the tape is off). The grace covers a late tape, or a tape viewport being re-opened.
- `stats` counts events applied, resyncs, gaps, resets and mismatches.

`useBookQueue(ric, { events: true })` in `@heswell/trading-ui` drives a `BookFeed` from three viewports: `bookOrders`,
`bookStatus` and `bookEvents`. It reads the tape forward: `ric = X and seq > N` sorted by seq ascending, starting
from the marker's seq and moving N to the highest seq received once half the `eventWindow` (500) has arrived or
every `eventAdvanceMs` (1 s). Rows only join the end of that window, so none is sent twice. `exchange-sim/__tests__/bookL3.test.ts`
drives one with skewed rows and markers, small and dropped windows and a restore, and checks the result against the
engine.

## Queue activity

`book.track(orderId)` counts, from the events applied after it, the size filled ahead of the order, the size
cancelled, reduced or re-queued ahead of it, and its own fills. Nothing joins ahead of a resting order (unless it is itself re-queued), so these
never exceed what was ahead of it. A resync from a snapshot sets `partial`: the counts are then lower bounds.
