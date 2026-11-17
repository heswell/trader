import { describe, expect, test } from "bun:test";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import type { ReactNode } from "react";
import {
  channelOfRic,
  clearChannel,
  createInstrumentLinkBus,
  DEFAULT_LINK_GROUPS,
  GridChannelLinksProvider,
  type InstrumentLinkBus,
  InstrumentContextProvider,
  linkInstrument,
  rowRicOf,
  useGridChannelLinks,
  WorkspaceChannelProvider,
} from "../src";
import { LinkCell } from "../src/components/InstrumentGrid/linkColumn";

const channels = DEFAULT_LINK_GROUPS;
const ricOf = (bus: InstrumentLinkBus, channel: string) =>
  bus.getSelection(channel)?.instrument?.ric;

describe("one channel per instrument", () => {
  test("linking to another channel moves the instrument", () => {
    const bus = createInstrumentLinkBus();
    linkInstrument(bus, channels, "green", { ric: "BP.L" });
    linkInstrument(bus, channels, "red", { ric: "VOD.L" });
    expect(channelOfRic(bus, channels, "BP.L")?.id).toBe("green");

    expect(linkInstrument(bus, channels, "blue", { ric: "BP.L" })).toBe(true);
    expect(ricOf(bus, "blue")).toBe("BP.L");
    expect(ricOf(bus, "green")).toBeUndefined();
    expect(ricOf(bus, "red")).toBe("VOD.L");
    expect(channelOfRic(bus, channels, "BP.L")?.id).toBe("blue");
  });

  test("linking to the channel that holds it changes nothing", () => {
    const bus = createInstrumentLinkBus();
    linkInstrument(bus, channels, "green", { ric: "BP.L" });
    expect(linkInstrument(bus, channels, "green", { ric: "BP.L" })).toBe(false);
  });

  test("clearChannel empties a channel", () => {
    const bus = createInstrumentLinkBus();
    linkInstrument(bus, channels, "green", { ric: "BP.L" });
    expect(clearChannel(bus, "green")).toBe(true);
    expect(channelOfRic(bus, channels, "BP.L")).toBeUndefined();
  });
});

const wrapperFor =
  (bus: InstrumentLinkBus, activeChannel = "blue") =>
  ({ children }: { children: ReactNode }) => (
    <InstrumentContextProvider bus={bus}>
      <WorkspaceChannelProvider defaultActiveChannel={activeChannel}>
        {children}
      </WorkspaceChannelProvider>
    </InstrumentContextProvider>
  );

describe("useGridChannelLinks", () => {
  test("follows channels changed elsewhere and links with static data", () => {
    const bus = createInstrumentLinkBus();
    const { result } = renderHook(() => useGridChannelLinks(), {
      wrapper: wrapperFor(bus),
    });
    expect(result.current.activeChannel).toBe("blue");
    expect(result.current.channelOf("BP.L")).toBeUndefined();

    act(() => {
      bus.publish("red", { ric: "BP.L" }, "ChannelPicker");
    });
    expect(result.current.channelOf("BP.L")?.id).toBe("red");

    act(() => {
      result.current.remember({ ric: "VOD.L", currency: "GBp" });
      result.current.linkRic("VOD.L", result.current.activeChannel);
    });
    expect(bus.getSelection("blue")?.instrument).toEqual({
      ric: "VOD.L",
      currency: "GBp",
    });
    expect(bus.getSelection("blue")?.source).toBe("InstrumentGrid");

    // moving BP.L to blue replaces VOD.L there and empties red
    act(() => {
      result.current.linkRic("BP.L", "blue");
    });
    expect(ricOf(bus, "blue")).toBe("BP.L");
    expect(ricOf(bus, "red")).toBeUndefined();
  });
});

const GridLinks = ({ children }: { children: ReactNode }) => {
  const links = useGridChannelLinks();
  return (
    <GridChannelLinksProvider value={links}>
      {children}
    </GridChannelLinksProvider>
  );
};

const renderCell = (bus: InstrumentLinkBus, ric: string) => {
  const Wrapper = wrapperFor(bus, "red");
  return render(
    <Wrapper>
      <GridLinks>
        <div className="vuuTableRow">
          <LinkCell
            {...({
              column: { name: "link" },
              dataRow: { ric, description: `${ric} plc` },
            } as unknown as TableCellRendererProps)}
          />
          <span data-testid="other-cell">x</span>
        </div>
      </GridLinks>
    </Wrapper>,
  );
};

describe("LinkCell", () => {
  test("shows the channel of the row and links from its menu", async () => {
    const bus = createInstrumentLinkBus();
    bus.publish("green", { ric: "BP.L" });
    bus.publish("blue", { ric: "VOD.L" });
    renderCell(bus, "BP.L");

    const button = screen.getByRole("button", {
      name: "BP.L is on the Green channel",
    });
    expect(rowRicOf(screen.getByTestId("other-cell"))).toBe("BP.L");

    fireEvent.click(button);
    expect(await screen.findByText("Move BP.L from Green to")).toBeTruthy();
    expect(screen.getByText("Linked · click to clear")).toBeTruthy();
    expect(screen.getByText("replaces VOD.L")).toBeTruthy();
    expect(screen.getAllByText("empty")).toHaveLength(2);

    fireEvent.click(screen.getByRole("menuitem", { name: /Blue/ }));
    expect(ricOf(bus, "blue")).toBe("BP.L");
    expect(ricOf(bus, "green")).toBeUndefined();
    expect(bus.getSelection("blue")?.instrument?.description).toBe("BP.L plc");
    expect(
      screen.getByRole("button", { name: "BP.L is on the Blue channel" }),
    ).toBeTruthy();
  });

  test("an unlinked row offers to link; its own channel clears", async () => {
    const bus = createInstrumentLinkBus();
    renderCell(bus, "BP.L");
    fireEvent.click(
      screen.getByRole("button", { name: "Link BP.L to a channel" }),
    );
    expect(await screen.findByText("Link BP.L to channel")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Red/ }));
    expect(ricOf(bus, "red")).toBe("BP.L");

    fireEvent.click(
      screen.getByRole("button", {
        name: "BP.L is on the Red channel (active)",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Red/ }));
    expect(ricOf(bus, "red")).toBeUndefined();
  });
});
