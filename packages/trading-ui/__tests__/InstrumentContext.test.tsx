import { afterEach, describe, expect, test } from "bun:test";
import { ViewContext, type ViewContextAPI } from "@vuu-ui/vuu-layout";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import {
  createInstrumentLinkBus,
  getInstrumentLinkBus,
  InstrumentContextProvider,
  type InstrumentSelection,
  LINK_GROUP_STATE_KEY,
  LinkGroupProvider,
  LinkGroupSelector,
  type LinkGroupId,
  type SelectedInstrument,
  useComponentLinkGroup,
  useSelectedInstrument,
} from "../src";

afterEach(() => {
  cleanup();
  getInstrumentLinkBus().clear();
});

let select: (i: SelectedInstrument | undefined, source?: string) => void;
const Consumer = ({ linkGroup }: { linkGroup?: LinkGroupId }) => {
  const { selectedInstrument, selectionSource, setSelectedInstrument } =
    useSelectedInstrument({ linkGroup });
  useEffect(() => {
    select = setSelectedInstrument;
  }, [setSelectedInstrument]);
  return (
    <span data-testid="selected">
      {selectedInstrument?.ric ?? "none"}:{selectionSource ?? ""}
    </span>
  );
};

describe("instrument context", () => {
  test("shares the selection between consumers", () => {
    const changes: InstrumentSelection[] = [];
    render(
      <InstrumentContextProvider
        initialInstrument={{ ric: "AAPL.OQ" }}
        onSelectionChange={(s) => changes.push(s)}
      >
        <Consumer />
      </InstrumentContextProvider>,
    );
    expect(screen.getByTestId("selected").textContent).toBe("AAPL.OQ:");
    act(() => select({ ric: "VOD.L", tickSize: 0.02 }, "grid"));
    expect(screen.getByTestId("selected").textContent).toBe("VOD.L:grid");
    expect(changes).toEqual([
      { instrument: { ric: "VOD.L", tickSize: 0.02 }, source: "grid" },
    ]);
  });

  test("without a provider consumers share the window-wide bus", () => {
    render(<Consumer />);
    expect(screen.getByTestId("selected").textContent).toBe("none:");
    act(() => select({ ric: "VOD.L" }, "grid"));
    expect(screen.getByTestId("selected").textContent).toBe("VOD.L:grid");
    // e.g. a separately mounted MF feature, in a different React root
    expect(getInstrumentLinkBus().getSelection("red")?.instrument?.ric).toBe(
      "VOD.L",
    );
    act(() => {
      getInstrumentLinkBus().publish("red", { ric: "BP.L" }, "other-root");
    });
    expect(screen.getByTestId("selected").textContent).toBe("BP.L:other-root");
  });

  test("a provider without a bus is isolated from the window bus", () => {
    render(
      <InstrumentContextProvider>
        <Consumer />
      </InstrumentContextProvider>,
    );
    act(() => select({ ric: "VOD.L" }));
    expect(getInstrumentLinkBus().getSelection("red")).toBeUndefined();
  });

  test("link groups isolate consumers; unlinked is private per consumer", () => {
    const bus = createInstrumentLinkBus();
    const selects: Record<string, typeof select> = {};
    const Named = ({
      name,
      linkGroup,
    }: {
      name: string;
      linkGroup: LinkGroupId;
    }) => {
      const { selectedInstrument, setSelectedInstrument } =
        useSelectedInstrument({ linkGroup });
      selects[name] = setSelectedInstrument;
      return (
        <span data-testid={name}>{selectedInstrument?.ric ?? "none"}</span>
      );
    };
    render(
      <InstrumentContextProvider bus={bus}>
        <Named name="red1" linkGroup="red" />
        <Named name="red2" linkGroup="red" />
        <Named name="green" linkGroup="green" />
        <Named name="u1" linkGroup="unlinked" />
        <Named name="u2" linkGroup="unlinked" />
      </InstrumentContextProvider>,
    );
    act(() => selects.red1({ ric: "VOD.L" }));
    act(() => selects.u1({ ric: "AAPL.OQ" }));
    const text = (id: string) => screen.getByTestId(id).textContent;
    expect([
      text("red1"),
      text("red2"),
      text("green"),
      text("u1"),
      text("u2"),
    ]).toEqual(["VOD.L", "VOD.L", "none", "AAPL.OQ", "none"]);
  });

  test("LinkGroupProvider sets the default group of a subtree", () => {
    const bus = createInstrumentLinkBus();
    render(
      <InstrumentContextProvider bus={bus}>
        <LinkGroupProvider linkGroup="blue">
          <Consumer />
        </LinkGroupProvider>
      </InstrumentContextProvider>,
    );
    act(() => select({ ric: "VOD.L" }));
    expect(bus.getSelection("blue")?.instrument?.ric).toBe("VOD.L");
    expect(bus.getSelection("red")).toBeUndefined();
  });
});

describe("useComponentLinkGroup", () => {
  const viewApi = (store: Record<string, unknown>): ViewContextAPI => ({
    load: <T,>(key?: string) => store[key ?? ""] as T,
    save: (state: unknown, key: string) => {
      store[key] = state;
    },
    setComponentProps: () => undefined,
  });

  test("saves the chosen group in the enclosing vuu-layout View and restores it", () => {
    const store: Record<string, unknown> = {};
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ViewContext.Provider value={viewApi(store)}>
        {children}
      </ViewContext.Provider>
    );
    const changes: string[] = [];
    const { result, unmount } = renderHook(
      () =>
        useComponentLinkGroup({ onLinkGroupChange: (g) => changes.push(g) }),
      { wrapper },
    );
    expect(result.current.linkGroup).toBe("red");
    act(() => result.current.setLinkGroup("green"));
    expect(result.current.linkGroup).toBe("green");
    expect(store[LINK_GROUP_STATE_KEY]).toBe("green");
    expect(changes).toEqual(["green"]);
    unmount();

    const restored = renderHook(() => useComponentLinkGroup(), { wrapper });
    expect(restored.result.current.linkGroup).toBe("green");
  });

  test("prop wins over saved state and later prop changes apply", () => {
    const store: Record<string, unknown> = { [LINK_GROUP_STATE_KEY]: "green" };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ViewContext.Provider value={viewApi(store)}>
        {children}
      </ViewContext.Provider>
    );
    const { result, rerender } = renderHook(
      ({ linkGroup }: { linkGroup?: string }) =>
        useComponentLinkGroup({ linkGroup }),
      { wrapper, initialProps: { linkGroup: "blue" } },
    );
    expect(result.current.linkGroup).toBe("blue");
    rerender({ linkGroup: "yellow" });
    expect(result.current.linkGroup).toBe("yellow");
  });

  test("defaultLinkGroup applies with nothing saved; unlinked gets a private channel", () => {
    const { result } = renderHook(() =>
      useComponentLinkGroup({ defaultLinkGroup: "unlinked" }),
    );
    expect(result.current.linkGroup).toBe("unlinked");
    expect(result.current.channel).toStartWith("unlinked:");
  });
});

describe("LinkGroupSelector", () => {
  test("shows the current group", () => {
    render(<LinkGroupSelector value="green" onChange={() => undefined} />);
    const button = screen.getByRole("combobox");
    expect(button.getAttribute("data-link-group")).toBe("green");
    expect(button.getAttribute("aria-label")).toBe("Link group");
  });
});
