import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { getRowClassNameGenerator } from "@vuu-ui/vuu-utils";
import {
  channelRowClassName,
  channelRowColorRules,
  createInstrumentLinkBus,
  DEFAULT_LINK_GROUPS,
  InstrumentContextProvider,
  linkInstrument,
  useChannelRowMarkers,
} from "../src";

afterEach(cleanup);

const config: TableConfig = { columns: [{ name: "ric" }] };

describe("channel row markers", () => {
  test("class and colour rule per channel", () => {
    const red = DEFAULT_LINK_GROUPS[0];
    expect(channelRowClassName(red)).toBe(
      `tradingChannelRow tradingChannelRow-${red.id}`,
    );
    expect(channelRowColorRules([red])).toBe(
      `.tradingChannelRow-${red.id}{--tradingChannelRow-color:${red.color}}`,
    );
  });

  test("rows whose ric is on a channel get its class; the config stays stable", () => {
    const bus = createInstrumentLinkBus();
    const configs: TableConfig[] = [];
    const Probe = () => {
      configs.push(useChannelRowMarkers(config).tableConfig);
      return null;
    };
    render(
      <InstrumentContextProvider bus={bus}>
        <Probe />
      </InstrumentContextProvider>,
    );
    const ids = configs[0].rowClassNameGenerators ?? [];
    expect(ids).toHaveLength(1);
    const generator = getRowClassNameGenerator(ids[0]);
    const classOf = (ric: string) =>
      generator?.fn({ ric } as never, undefined, undefined);
    expect(classOf("BARC.L")).toBeUndefined();

    const [red, green] = DEFAULT_LINK_GROUPS;
    act(() =>
      linkInstrument(
        bus,
        DEFAULT_LINK_GROUPS,
        red.id,
        { ric: "BARC.L" },
        "test",
      ),
    );
    expect(classOf("BARC.L")).toBe(channelRowClassName(red));
    expect(classOf("VOD.L")).toBeUndefined();

    // one channel per instrument: moving it to green unmarks red
    act(() =>
      linkInstrument(
        bus,
        DEFAULT_LINK_GROUPS,
        green.id,
        { ric: "BARC.L" },
        "test",
      ),
    );
    expect(classOf("BARC.L")).toBe(channelRowClassName(green));
    // the caller re-rendered, with the same config object
    expect(configs.length).toBeGreaterThan(1);
    expect(new Set(configs).size).toBe(1);
  });
});
