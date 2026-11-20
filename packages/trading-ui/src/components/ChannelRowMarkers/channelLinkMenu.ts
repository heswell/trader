import type { ContextMenuItemDescriptor } from "@vuu-ui/vuu-context-menu";
import { linkInstrument } from "../../instrument-context/channelLinks";
import type { InstrumentLinkBus } from "../../instrument-context/instrumentLinkBus";
import type { LinkGroupId } from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import type { ChannelRics } from "./useChannelRics";

/** Menu action id prefix: `trading-link-channel:<channel id>`. */
export const CHANNEL_LINK_ACTION = "trading-link-channel:";

/** The label of one channel in the "Link <ric> to" submenu. */
export const channelLinkLabel = (
  channel: { id: LinkGroupId; label: string },
  ric: string,
  { byRic, selections }: Pick<ChannelRics, "byRic" | "selections">,
) => {
  if (byRic.get(ric)?.id === channel.id) return `${channel.label} · ${ric} ✓`;
  const current = selections.get(channel.id)?.ric;
  return `${channel.label} · ${current ?? "empty"}`;
};

/**
 * A secondary "Link <ric> to ▸" item: one entry per workspace channel,
 * with the instrument it holds now. Choosing one links the instrument
 * there (and off any other channel). Blotters publish only this way.
 */
export const channelLinkMenuItem = (
  instrument: SelectedInstrument,
  channelRics: Pick<ChannelRics, "byRic" | "channels" | "selections">,
  dividerBefore = false,
): ContextMenuItemDescriptor => ({
  label: `Link ${instrument.ric} to`,
  dividerBefore,
  children: channelRics.channels.map((channel) => ({
    id: `${CHANNEL_LINK_ACTION}${channel.id}`,
    label: channelLinkLabel(channel, instrument.ric, channelRics),
    options: instrument as never,
  })),
});

/**
 * Handle a channel-link menu action; false if `id` is not one.
 */
export const handleChannelLinkAction = (
  id: string,
  options: unknown,
  bus: InstrumentLinkBus,
  channels: ChannelRics["channels"],
  source: string,
) => {
  if (!id.startsWith(CHANNEL_LINK_ACTION)) return false;
  const channel = id.slice(CHANNEL_LINK_ACTION.length);
  linkInstrument(bus, channels, channel, options as SelectedInstrument, source);
  return true;
};
