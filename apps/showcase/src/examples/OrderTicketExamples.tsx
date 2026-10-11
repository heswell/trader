import { OrdType, Side } from "@heswell/trading-schemas";
import {
  OrderTicket,
  OrderTicketDialog,
  OrderTicketPanel,
  type OrderTicketPrefill,
  type TradingOrderEvent,
  useOrderTicketLauncher,
  useSelectedInstrument,
} from "@heswell/trading-ui";
import { Button, Text } from "@salt-ds/core";
import { useState } from "react";

const EventLog = ({ events }: { events: TradingOrderEvent[] }) => (
  <ol aria-label="Order events" style={{ fontSize: 12, margin: 0 }}>
    {events.slice(-8).map((e, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
      <li key={i}>
        {e.kind} {e.clOrdId ?? e.orderId} {e.status ?? ""} {e.reason ?? ""}
      </li>
    ))}
  </ol>
);

const useEventLog = () => {
  const [events, setEvents] = useState<TradingOrderEvent[]>([]);
  return [
    events,
    (e: TradingOrderEvent) => setEvents((l) => l.concat(e)),
  ] as const;
};

/** Docked panel, also the target of openOrderTicket() prefills. */
export const OrderTicketDocked = () => {
  const [events, onOrderEvent] = useEventLog();
  const { openOrderTicket } = useOrderTicketLauncher();
  const { selectedInstrument } = useSelectedInstrument();
  const ric = selectedInstrument?.ric;
  const prefill = (p: OrderTicketPrefill) => () =>
    openOrderTicket({ ric, ...p });
  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        padding: 16,
        alignItems: "flex-start",
      }}
    >
      <OrderTicketPanel onOrderEvent={onOrderEvent} style={{ width: 380 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Text styleAs="label">Prefill (as a grid / ladder would)</Text>
        <Button onClick={prefill({ side: Side.Buy, ordType: OrdType.Market })}>
          Buy market
        </Button>
        <Button onClick={prefill({ side: Side.Sell, ordType: OrdType.Limit })}>
          Sell limit
        </Button>
        <Text styleAs="label">
          Keys: B / S side, ↑ / ↓ nudge, F9 or Ctrl+Enter submit, Esc reset
        </Text>
        <EventLog events={events} />
      </div>
    </div>
  );
};

/** Modal dialog. */
export const OrderTicketDialogExample = () => {
  const [open, setOpen] = useState(false);
  const [events, onOrderEvent] = useEventLog();
  return (
    <div style={{ padding: 16 }}>
      <Button onClick={() => setOpen(true)} sentiment="accented">
        New order…
      </Button>
      <OrderTicketDialog
        onClose={() => setOpen(false)}
        onOrderEvent={onOrderEvent}
        open={open}
      />
      <EventLog events={events} />
    </div>
  );
};

/** Compact inline strip (grid row / ladder). */
export const OrderTicketCompact = () => {
  const [events, onOrderEvent] = useEventLog();
  return (
    <div
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}
    >
      <OrderTicket
        onOrderEvent={onOrderEvent}
        prefill={{ quantity: 100, ordType: OrdType.Limit }}
        variant="compact"
      />
      <EventLog events={events} />
    </div>
  );
};

/** openOrderTicket() without a docked ticket opens the dialog. */
export const OrderTicketLauncherExample = () => {
  const { openOrderTicket } = useOrderTicketLauncher();
  const { selectedInstrument } = useSelectedInstrument();
  const ric = selectedInstrument?.ric;
  return (
    <div style={{ display: "flex", gap: 8, padding: 16 }}>
      <Button
        onClick={() => openOrderTicket({ ric, side: Side.Buy })}
        sentiment="positive"
      >
        Buy {ric}
      </Button>
      <Button
        onClick={() => openOrderTicket({ ric, side: Side.Sell })}
        sentiment="negative"
      >
        Sell {ric}
      </Button>
    </div>
  );
};
