import {
  type LinkGroupDefinition,
  type LinkGroupId,
  type SelectedInstrument,
  useInstrumentLinkBus,
} from "@heswell/trading-ui";
import { useCallback, useRef, useSyncExternalStore } from "react";

export type ChannelSelections = ReadonlyMap<
  LinkGroupId,
  SelectedInstrument | undefined
>;

/**
 * The selected instrument of each channel, from the link bus. The returned
 * map only changes identity when a channel's selection changes.
 */
export const useChannelSelections = (
  channels: readonly LinkGroupDefinition[],
): ChannelSelections => {
  const bus = useInstrumentLinkBus();
  const cache = useRef<{ key: string; value: ChannelSelections }>({
    key: "",
    value: new Map(),
  });

  const subscribe = useCallback(
    (onChange: () => void) => bus.subscribeAll(onChange),
    [bus],
  );
  const getSnapshot = useCallback(() => {
    // seq changes with every selection (including new static data)
    const key = channels
      .map(({ id }) => `${id}:${bus.getSelection(id)?.seq ?? ""}`)
      .join("|");
    if (key !== cache.current.key) {
      cache.current = {
        key,
        value: new Map(
          channels.map(({ id }) => [id, bus.getSelection(id)?.instrument]),
        ),
      };
    }
    return cache.current.value;
  }, [bus, channels]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** The channels (colours) that currently show each ric. */
export const channelsByRic = (
  channels: readonly LinkGroupDefinition[],
  selections: ChannelSelections,
): ReadonlyMap<string, readonly LinkGroupDefinition[]> => {
  const byRic = new Map<string, LinkGroupDefinition[]>();
  for (const channel of channels) {
    const ric = selections.get(channel.id)?.ric;
    if (!ric) continue;
    const list = byRic.get(ric);
    if (list) list.push(channel);
    else byRic.set(ric, [channel]);
  }
  return byRic;
};
