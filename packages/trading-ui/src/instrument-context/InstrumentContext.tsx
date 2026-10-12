import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useInstrumentLookup } from "../components/InstrumentLookup/InstrumentLookup";
import {
  createInstrumentLinkBus,
  getInstrumentLinkBus,
  type InstrumentLinkBus,
} from "./instrumentLinkBus";
import { DEFAULT_LINK_GROUP, type LinkGroupId, UNLINKED } from "./linkGroups";
import {
  type SelectedInstrument,
  sanitizeSelectedInstrument,
} from "./selectedInstrument";

export type { SelectedInstrument } from "./selectedInstrument";

export interface InstrumentSelection {
  instrument: SelectedInstrument | undefined;
  /** Id of the component that made the selection (ignore your own echoes). */
  source?: string;
}

/**
 * The selection of one link group, as seen by a component. Components read
 * `selectedInstrument` and call `setSelectedInstrument`; they never talk to
 * each other directly.
 */
export interface InstrumentContextValue {
  selectedInstrument: SelectedInstrument | undefined;
  /** Id of the component that made the current selection, if given. */
  selectionSource: string | undefined;
  /**
   * Publish to the link group (a no-op for the same instrument, or a blank
   * ric). Static data from the InstrumentLookup is merged in when the
   * caller only has the ric.
   */
  setSelectedInstrument: (
    instrument: SelectedInstrument | undefined,
    source?: string,
  ) => void;
  /** The group this value belongs to (`unlinked` for a private one). */
  linkGroup: LinkGroupId;
}

interface InstrumentLinkContextValue {
  bus: InstrumentLinkBus;
  linkGroup?: LinkGroupId;
}

const InstrumentLinkContext = createContext<
  InstrumentLinkContextValue | undefined
>(undefined);

const LinkGroupContext = createContext<LinkGroupId | undefined>(undefined);

/**
 * The bus used below this point: the nearest InstrumentContextProvider's,
 * else the window-wide shared bus (getInstrumentLinkBus).
 */
export const useInstrumentLinkBus = (): InstrumentLinkBus =>
  useContext(InstrumentLinkContext)?.bus ?? getInstrumentLinkBus();

/**
 * The link group components below this point join when they have no
 * `linkGroup` prop of their own.
 */
export const useInheritedLinkGroup = (): LinkGroupId => {
  const scoped = useContext(LinkGroupContext);
  const provider = useContext(InstrumentLinkContext);
  return scoped ?? provider?.linkGroup ?? DEFAULT_LINK_GROUP;
};

/**
 * Put a subtree in a link group (e.g. everything in one MF feature, or the
 * children of a component). Components with their own `linkGroup` win.
 */
export const LinkGroupProvider = ({
  children,
  linkGroup,
}: {
  children: ReactNode;
  linkGroup: LinkGroupId;
}) => (
  <LinkGroupContext.Provider value={linkGroup}>
    {children}
  </LinkGroupContext.Provider>
);

export interface InstrumentContextProviderProps {
  children: ReactNode;
  /**
   * The bus to use. Default: a private bus for this provider, so it is
   * isolated (tests, embedded previews). Pass `getInstrumentLinkBus()` to
   * link with everything else in the window, e.g. other MF features.
   */
  bus?: InstrumentLinkBus;
  /** Default group of components below (default DEFAULT_LINK_GROUP). */
  linkGroup?: LinkGroupId;
  /** Selected in `linkGroup` on mount, if nothing is selected there yet. */
  initialInstrument?: SelectedInstrument;
  /** Observe selection changes of `linkGroup` (to persist or bridge them). */
  onSelectionChange?: (selection: InstrumentSelection) => void;
}

/**
 * Optional scope for the instrument link bus. Without any provider,
 * components use the window-wide bus (which is what separately mounted MF
 * features need); a provider gives its subtree a private bus (or `bus`)
 * and a default link group.
 */
export const InstrumentContextProvider = ({
  bus: busProp,
  children,
  initialInstrument,
  linkGroup = DEFAULT_LINK_GROUP,
  onSelectionChange,
}: InstrumentContextProviderProps) => {
  const [privateBus] = useState(() =>
    busProp ? undefined : createInstrumentLinkBus(),
  );
  const bus = busProp ?? privateBus ?? getInstrumentLinkBus();
  useState(() => {
    if (initialInstrument && !bus.getSelection(linkGroup)?.instrument) {
      bus.publish(linkGroup, initialInstrument);
    }
  });
  const onChangeRef = useRef(onSelectionChange);
  onChangeRef.current = onSelectionChange;
  useEffect(
    () =>
      bus.subscribe(linkGroup, ({ instrument, source }) =>
        onChangeRef.current?.({ instrument, source }),
      ),
    [bus, linkGroup],
  );
  const value = useMemo(() => ({ bus, linkGroup }), [bus, linkGroup]);
  return (
    <InstrumentLinkContext.Provider value={value}>
      {children}
    </InstrumentLinkContext.Provider>
  );
};

export interface UseSelectedInstrumentOptions {
  /**
   * Group to read / publish. Default: the enclosing LinkGroupProvider's or
   * InstrumentContextProvider's group, else DEFAULT_LINK_GROUP. `unlinked`
   * gives this hook call its own private selection.
   */
  linkGroup?: LinkGroupId;
}

/**
 * Read / set the selected instrument of a link group. Works without any
 * provider (window-wide bus, default group).
 */
export const useSelectedInstrument = ({
  linkGroup: linkGroupOption,
}: UseSelectedInstrumentOptions = {}): InstrumentContextValue => {
  const bus = useInstrumentLinkBus();
  const inherited = useInheritedLinkGroup();
  const privateId = useId();
  const linkGroup = linkGroupOption ?? inherited;
  const channel =
    linkGroup === UNLINKED ? `${UNLINKED}:${privateId}` : linkGroup;

  const subscribe = useCallback(
    (onChange: () => void) => bus.subscribe(channel, onChange),
    [bus, channel],
  );
  const getSnapshot = useCallback(
    () => bus.getSelection(channel),
    [bus, channel],
  );
  const selection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const lookup = useInstrumentLookup();
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const setSelectedInstrument = useCallback(
    (instrument: SelectedInstrument | undefined, source?: string) => {
      const plain = sanitizeSelectedInstrument(instrument);
      const known = plain && lookupRef.current.get(plain.ric);
      bus.publish(
        channel,
        known && plain ? { ...known, ...plain } : instrument,
        source,
      );
    },
    [bus, channel],
  );

  return useMemo(
    () => ({
      selectedInstrument: selection?.instrument,
      selectionSource: selection?.source,
      setSelectedInstrument,
      linkGroup,
    }),
    [selection, setSelectedInstrument, linkGroup],
  );
};
