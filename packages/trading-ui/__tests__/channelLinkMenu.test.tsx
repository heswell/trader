import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import {
  CHANNEL_LINK_ACTION,
  channelLinkMenuItem,
  createInstrumentLinkBus,
  DEFAULT_LINK_GROUPS,
  handleChannelLinkAction,
  InstrumentContextProvider,
  linkInstrument,
  useChannelRowMarkers,
} from "../src";

afterEach(cleanup);

const config: TableConfig = { columns: [{ name: "ric" }] };

type Markers = ReturnType<typeof useChannelRowMarkers>;

const setup = () => {
  const bus = createInstrumentLinkBus();
  const latest: { markers?: Markers } = {};
  const Probe = () => {
    latest.markers = useChannelRowMarkers(config);
    return null;
  };
  render(
    <InstrumentContextProvider bus={bus}>
      <Probe />
    </InstrumentContextProvider>,
  );
  return { bus, latest };
};

describe("Link <ric> to menu", () => {
  test("one entry per channel, showing what each holds", () => {
    const { bus, latest } = setup();
    const [red, green] = DEFAULT_LINK_GROUPS;
    act(() =>
      linkInstrument(bus, DEFAULT_LINK_GROUPS, red.id, { ric: "VOD.L" }, "t"),
    );
    act(() =>
      linkInstrument(
        bus,
        DEFAULT_LINK_GROUPS,
        green.id,
        { ric: "BARC.L" },
        "t",
      ),
    );
    const item = channelLinkMenuItem({ ric: "BARC.L" }, latest.markers!);
    expect(item.label).toBe("Link BARC.L to");
    const children = (item as { children: { id: string; label: string }[] })
      .children;
    expect(children).toHaveLength(latest.markers!.channels.length);
    expect(children[0]).toMatchObject({
      id: `${CHANNEL_LINK_ACTION}${red.id}`,
      label: `${red.label} · VOD.L`,
    });
    expect(children[1].label).toBe(`${green.label} · BARC.L ✓`);
    if (children[2]) expect(children[2].label).toMatch(/· empty$/);
  });

  test("choosing a channel links the ric there and off its old channel", () => {
    const { bus, latest } = setup();
    const [red, green] = DEFAULT_LINK_GROUPS;
    act(() =>
      linkInstrument(bus, DEFAULT_LINK_GROUPS, red.id, { ric: "BARC.L" }, "t"),
    );
    expect(latest.markers!.byRic.get("BARC.L")?.id).toBe(red.id);
    let handled = false;
    act(() => {
      handled = handleChannelLinkAction(
        `${CHANNEL_LINK_ACTION}${green.id}`,
        { ric: "BARC.L" },
        bus,
        latest.markers!.channels,
        "OrderBlotter",
      );
    });
    expect(handled).toBe(true);
    expect(latest.markers!.byRic.get("BARC.L")?.id).toBe(green.id);
    expect(latest.markers!.selections.get(red.id)?.ric).toBeUndefined();
  });

  test("other actions are left to the caller", () => {
    const { bus, latest } = setup();
    expect(
      handleChannelLinkAction(
        "order-cancel",
        { orderId: "1" },
        bus,
        latest.markers!.channels,
        "OrderBlotter",
      ),
    ).toBe(false);
  });
});
