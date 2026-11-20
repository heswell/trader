import { useMemo } from "react";
import {
  DEFAULT_LINK_GROUP,
  DEFAULT_LINK_GROUPS,
  type LinkGroupDefinition,
  type LinkGroupId,
} from "../../instrument-context/linkGroups";
import { useOptionalWorkspaceChannel } from "../../instrument-context/workspaceChannel";
import {
  type ChannelSelections,
  useChannelSelections,
} from "../ChannelPicker/useChannelSelections";

export interface ChannelRics {
  /** The workspace channels, in picker order. */
  channels: readonly LinkGroupDefinition[];
  /** The workspace's active channel. */
  activeChannel: LinkGroupId;
  /** The instrument each channel holds now. */
  selections: ChannelSelections;
  /** The channel holding each ric (one channel per ric, the first wins). */
  byRic: ReadonlyMap<string, LinkGroupDefinition>;
  /** Rics on a channel, in channel order. Stable while the set is unchanged. */
  linkedRics: readonly string[];
}

/**
 * Which ric each workspace channel holds, read-only. Uses the workspace
 * channels (WorkspaceChannelProvider), else the default channels with red
 * active. Shared by the instrument grid's link column and the blotters'
 * channel markers.
 */
export const useChannelRics = (): ChannelRics => {
  const workspace = useOptionalWorkspaceChannel();
  const channels = workspace?.channels ?? DEFAULT_LINK_GROUPS;
  const activeChannel = workspace?.activeChannel ?? DEFAULT_LINK_GROUP;
  const selections = useChannelSelections(channels);
  const byRic = useMemo(() => {
    const map = new Map<string, LinkGroupDefinition>();
    for (const channel of channels) {
      const ric = selections.get(channel.id)?.ric;
      if (ric && !map.has(ric)) map.set(ric, channel);
    }
    return map;
  }, [channels, selections]);
  const linkedRicsJson = JSON.stringify([...byRic.keys()]);
  const linkedRics = useMemo<readonly string[]>(
    () => JSON.parse(linkedRicsJson),
    [linkedRicsJson],
  );
  return { activeChannel, byRic, channels, linkedRics, selections };
};
