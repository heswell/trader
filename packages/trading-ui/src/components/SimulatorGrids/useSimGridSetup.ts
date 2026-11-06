import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type { TableRowSelectHandler } from "@vuu-ui/vuu-table-types";
import { useCallback } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { useInstrumentLookup } from "../InstrumentLookup";
import simulatorGridsCss from "./SimulatorGrids.css";

export const simGridClass = "tradingSimGrid";

export const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

/** CSS, link group and a row-select handler that links the row's ric. */
export const useSimGridSetup = (
  name: string,
  { defaultLinkGroup, linkGroup, onLinkGroupChange }: LinkGroupProps,
  id: string | undefined,
  onRowSelect?: (row: Record<string, unknown> | undefined) => void,
) => {
  useComponentCssInjection({
    testId: "trading-simulator-grids",
    css: simulatorGridsCss,
    window: useWindow(),
  });
  const lookup = useInstrumentLookup();
  const link = useComponentLinkGroup({
    defaultLinkGroup,
    linkGroup,
    onLinkGroupChange,
    persistKey: id ? `${name}:${id}` : name,
  });
  const { setSelectedInstrument } = useSelectedInstrument({
    linkGroup: link.channel,
  });
  const handleSelect = useCallback<TableRowSelectHandler>(
    (row) => {
      if (row?.isLeaf && typeof row.ric === "string") {
        setSelectedInstrument(lookup.get(row.ric) ?? { ric: row.ric }, name);
      }
      onRowSelect?.(row?.isLeaf ? (row as Record<string, unknown>) : undefined);
    },
    [lookup, name, onRowSelect, setSelectedInstrument],
  );
  return { ...link, handleSelect: useStableCallback(handleSelect) };
};
