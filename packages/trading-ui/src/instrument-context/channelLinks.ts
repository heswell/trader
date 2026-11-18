import type { InstrumentLinkBus } from "./instrumentLinkBus";
import type { LinkGroupDefinition, LinkGroupId } from "./linkGroups";
import type { SelectedInstrument } from "./selectedInstrument";

/** The channel (one of `channels`) whose instrument is `ric`, if any. */
export const channelOfRic = (
  bus: InstrumentLinkBus,
  channels: readonly LinkGroupDefinition[],
  ric: string,
): LinkGroupDefinition | undefined =>
  channels.find(({ id }) => bus.getSelection(id)?.instrument?.ric === ric);

/**
 * Link `instrument` to `channel`, one channel per instrument: any other of
 * `channels` that holds the same ric is cleared, so linking to another
 * channel moves the instrument. Returns whether anything changed.
 */
export const linkInstrument = (
  bus: InstrumentLinkBus,
  channels: readonly LinkGroupDefinition[],
  channel: LinkGroupId,
  instrument: SelectedInstrument,
  source?: string,
): boolean => {
  let changed = false;
  for (const { id } of channels) {
    if (
      id !== channel &&
      bus.getSelection(id)?.instrument?.ric === instrument.ric
    ) {
      changed = bus.publish(id, undefined, source) || changed;
    }
  }
  return bus.publish(channel, instrument, source) || changed;
};

/** Empty `channel`. Returns whether anything changed. */
export const clearChannel = (
  bus: InstrumentLinkBus,
  channel: LinkGroupId,
  source?: string,
): boolean => bus.publish(channel, undefined, source);
