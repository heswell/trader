import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { type ReactNode, useState } from "react";
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
import {
  type GridChannelLinks,
  LinkCell,
  LinkHeader,
} from "../src/components/InstrumentGrid/linkColumn";

afterEach(cleanup);

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

  test("lists linked rics in channel order, stable while unchanged", () => {
    const bus = createInstrumentLinkBus();
    bus.publish("blue", { ric: "VOD.L" });
    bus.publish("red", { ric: "BP.L" });
    const { result } = renderHook(() => useGridChannelLinks(), {
      wrapper: wrapperFor(bus),
    });
    const first = result.current.linkedRics;
    expect(first).toEqual(["BP.L", "VOD.L"]);

    act(() => {
      result.current.setMenuRic("BP.L");
    });
    expect(result.current.linkedRics).toBe(first);

    act(() => {
      bus.publish("green", { ric: "HSBA.L" });
    });
    expect(result.current.linkedRics).toEqual(["BP.L", "HSBA.L", "VOD.L"]);
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

describe("LinkHeader", () => {
  const PinState = ({ children }: { children: ReactNode }) => {
    const links = useGridChannelLinks();
    const [pinLinked, setPinLinked] = useState(true);
    const value: GridChannelLinks = { ...links, pinLinked, setPinLinked };
    return (
      <GridChannelLinksProvider value={value}>
        {children}
      </GridChannelLinksProvider>
    );
  };

  test("toggles pinning of linked rows", () => {
    const Wrapper = wrapperFor(createInstrumentLinkBus());
    const onHeaderClick = mock();
    render(
      <Wrapper>
        <PinState>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: test of propagation */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: test of propagation */}
          <div onClick={onHeaderClick}>
            <LinkHeader />
          </div>
        </PinState>
      </Wrapper>,
    );
    const toggle = screen.getByRole("button", {
      name: "Pin linked rows to the top",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // not a click on the column header (sort)
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  test("renders nothing to press outside a grid", () => {
    const { container } = render(<LinkHeader />);
    expect(container.querySelector("button")).toBeNull();
  });
});
