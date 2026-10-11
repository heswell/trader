import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * The instrument other components should follow. `ric` is the key; the
 * other fields are optional static data (from `instruments`) so consumers
 * can format prices / validate quantities without another lookup.
 */
export interface SelectedInstrument {
  ric: string;
  description?: string;
  currency?: string;
  exchange?: string;
  tickSize?: number;
  /** Tick bands, as in the instruments table (`from:tick;...`). */
  tickBands?: string;
  lotSize?: number;
  priceDecimals?: number;
}

export interface InstrumentSelection {
  instrument: SelectedInstrument | undefined;
  /** Id of the component that made the selection (ignore your own echoes). */
  source?: string;
}

/**
 * Cross-component instrument context ("instrument bus"). Components read
 * `selectedInstrument` and call `setSelectedInstrument`; they never talk to
 * each other directly.
 *
 * P3.11 will back this with a bus shared across MF features and windows
 * (link groups / channels); this interface is the contract it will keep.
 */
export interface InstrumentContextValue {
  selectedInstrument: SelectedInstrument | undefined;
  /** Id of the component that made the current selection, if given. */
  selectionSource: string | undefined;
  setSelectedInstrument: (
    instrument: SelectedInstrument | undefined,
    source?: string,
  ) => void;
}

const NO_PROVIDER: InstrumentContextValue = {
  selectedInstrument: undefined,
  selectionSource: undefined,
  setSelectedInstrument: () => undefined,
};

export const InstrumentContext =
  createContext<InstrumentContextValue>(NO_PROVIDER);

export interface InstrumentContextProviderProps {
  children: ReactNode;
  initialInstrument?: SelectedInstrument;
  /** Observe selection changes (e.g. to persist or bridge them). */
  onSelectionChange?: (selection: InstrumentSelection) => void;
}

/** Placeholder implementation: React state scoped to this provider. */
export const InstrumentContextProvider = ({
  children,
  initialInstrument,
  onSelectionChange,
}: InstrumentContextProviderProps) => {
  const [selection, setSelection] = useState<InstrumentSelection>({
    instrument: initialInstrument,
  });
  const setSelectedInstrument = useCallback(
    (instrument: SelectedInstrument | undefined, source?: string) => {
      const next = { instrument, source };
      setSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );
  const value = useMemo(
    () => ({
      selectedInstrument: selection.instrument,
      selectionSource: selection.source,
      setSelectedInstrument,
    }),
    [selection, setSelectedInstrument],
  );
  return (
    <InstrumentContext.Provider value={value}>
      {children}
    </InstrumentContext.Provider>
  );
};

/**
 * Read / set the selected instrument. Safe without a provider: the
 * selection is then always undefined and setting it is a no-op.
 */
export const useSelectedInstrument = () => useContext(InstrumentContext);
