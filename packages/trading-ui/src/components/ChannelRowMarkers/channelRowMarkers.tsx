import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import { type ReactElement, useId, useMemo, useRef, useState } from "react";
import type { LinkGroupDefinition } from "../../instrument-context/linkGroups";
import channelRowMarkersCss from "./ChannelRowMarkers.css";
import { type ChannelRics, useChannelRics } from "./useChannelRics";

/** Class on a row whose ric is on a channel, plus `-<channel id>`. */
export const CHANNEL_ROW_CLASS = "tradingChannelRow";

const cssIdent = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The marker classes of a row whose ric is on `channel`. */
export const channelRowClassName = (channel: LinkGroupDefinition) =>
  `${CHANNEL_ROW_CLASS} ${CHANNEL_ROW_CLASS}-${cssIdent(channel.id)}`;

/** One rule per channel: the colour its marked rows show. */
export const channelRowColorRules = (
  channels: readonly LinkGroupDefinition[],
) =>
  channels
    .map(
      (channel) =>
        `.${CHANNEL_ROW_CLASS}-${cssIdent(channel.id)}{--tradingChannelRow-color:${channel.color}}`,
    )
    .join("\n");

export interface ChannelRowMarkers extends ChannelRics {
  /** `config` plus this instance's row-class generator. Stable. */
  tableConfig: TableConfig;
  /** Render once inside the component: the channel colours. */
  colorStyle: ReactElement;
}

/**
 * Display-only channel markers for a blotter: a row whose `ric` is on a
 * workspace channel shows the Table's left row bookend in that channel's
 * colour (hidden while the row is selected, which shows the normal
 * selection instead). Rows read the channels through a ref, so the
 * returned config stays stable (a new config would reset the Table's
 * columns): a channel change re-renders the caller, and so the Table,
 * which recomputes each row's class.
 */
export const useChannelRowMarkers = (
  config: TableConfig,
): ChannelRowMarkers => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-channel-row-markers",
    css: channelRowMarkersCss,
    window: targetWindow,
  });
  const channelRics = useChannelRics();
  const byRicRef = useRef(channelRics.byRic);
  byRicRef.current = channelRics.byRic;
  const generatorId = `trading.channel-row-markers${useId()}`;
  // register before the Table's first render reads it
  useState(() =>
    registerComponent(
      generatorId,
      {
        id: generatorId,
        fn: (dataRow) => {
          const channel = byRicRef.current.get(String(dataRow.ric));
          return channel ? channelRowClassName(channel) : undefined;
        },
      },
      "row-class-generator",
    ),
  );
  const tableConfig = useMemo<TableConfig>(
    () => ({
      ...config,
      rowClassNameGenerators: [
        ...(config.rowClassNameGenerators ?? []),
        generatorId,
      ],
    }),
    [config, generatorId],
  );
  const rules = channelRowColorRules(channelRics.channels);
  const colorStyle = useMemo(() => <style>{rules}</style>, [rules]);
  return { ...channelRics, colorStyle, tableConfig };
};
