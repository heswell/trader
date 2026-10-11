import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";

export type InstrumentLookup = ReadonlyMap<string, SelectedInstrument>;

const EMPTY: InstrumentLookup = new Map();
const InstrumentLookupContext = createContext<InstrumentLookup | undefined>(
  undefined,
);

const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const optionalString = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

const Subscribed = ({ children }: { children: ReactNode }) => {
  const dataSource = useTradingDataSource("instruments", {
    columns: [
      "ric",
      "description",
      "currency",
      "exchange",
      "tickSize",
      "tickBands",
      "lotSize",
      "priceDecimals",
    ],
  });
  const { rows: records } = useDataSourceRows(dataSource, { rowCount: 2_000 });
  const lookup = useMemo<InstrumentLookup>(
    () =>
      new Map(
        records.map((r) => [
          String(r.ric),
          {
            ric: String(r.ric),
            description: optionalString(r.description),
            currency: optionalString(r.currency),
            exchange: optionalString(r.exchange),
            tickSize: optionalNumber(r.tickSize),
            tickBands: optionalString(r.tickBands),
            lotSize: optionalNumber(r.lotSize),
            priceDecimals: optionalNumber(r.priceDecimals),
          },
        ]),
      ),
    [records],
  );
  return (
    <InstrumentLookupContext.Provider value={lookup}>
      {children}
    </InstrumentLookupContext.Provider>
  );
};

/**
 * Makes instrument static data (tick size / bands, decimals, currency, lot
 * size, description) available by ric to cell renderers and selection
 * handlers below it. Subscribes to `instruments` once. Nested providers reuse
 * the outer one, so blotters can each wrap themselves safely.
 */
export const InstrumentLookupProvider = ({
  children,
}: {
  children: ReactNode;
}) =>
  useContext(InstrumentLookupContext) ? (
    children
  ) : (
    <Subscribed>{children}</Subscribed>
  );

/** ric -> static instrument data; empty until loaded / without a provider. */
export const useInstrumentLookup = (): InstrumentLookup =>
  useContext(InstrumentLookupContext) ?? EMPTY;
