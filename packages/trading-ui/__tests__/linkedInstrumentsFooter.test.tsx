import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import {
  andFilters,
  DEFAULT_LINK_GROUPS,
  LinkedInstrumentsFooter,
  linkedInstruments,
  useLinkedRicFilter,
} from "../src";

afterEach(cleanup);

const [red, green] = DEFAULT_LINK_GROUPS;

describe("LinkedInstrumentsFooter", () => {
  test("one chip per linked ric, in channel order; ring on the active channel", () => {
    const instruments = linkedInstruments({
      channels: DEFAULT_LINK_GROUPS,
      selections: new Map([
        [green.id, { ric: "AAL.L" }],
        [red.id, { ric: "BARC.L" }],
      ]),
      byRic: new Map([
        ["BARC.L", red],
        ["AAL.L", green],
      ]),
    });
    expect(instruments.map((i) => [i.ric, i.channel.id])).toEqual([
      ["BARC.L", red.id],
      ["AAL.L", green.id],
    ]);
    const onFilterRic = mock<(ric?: string) => void>();
    render(
      <LinkedInstrumentsFooter
        activeChannel={red.id}
        instruments={instruments}
        onFilterRic={onFilterRic}
        summary="7 orders"
      />,
    );
    const barc = screen.getByRole("button", { name: "BARC.L" });
    expect(barc.hasAttribute("data-active")).toBe(true);
    expect(barc.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByRole("button", { name: "AAL.L" }).hasAttribute("data-active"),
    ).toBe(false);
    expect(screen.getByText("7 orders")).toBeTruthy();
    fireEvent.click(barc);
    expect(onFilterRic).toHaveBeenLastCalledWith("BARC.L");
  });

  test("the pressed chip clears the filter", () => {
    const onFilterRic = mock<(ric?: string) => void>();
    render(
      <LinkedInstrumentsFooter
        activeChannel={red.id}
        filterRic="BARC.L"
        instruments={[{ ric: "BARC.L", channel: red }]}
        onFilterRic={onFilterRic}
      />,
    );
    const barc = screen.getByRole("button", { name: "BARC.L" });
    expect(barc.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(barc);
    expect(onFilterRic).toHaveBeenLastCalledWith(undefined);
  });

  test("says so when no instrument is on a channel", () => {
    render(
      <LinkedInstrumentsFooter
        activeChannel={red.id}
        instruments={[]}
        onFilterRic={() => {}}
      />,
    );
    expect(screen.getByText("No instrument on a channel")).toBeTruthy();
  });

  test("the filter clears when its ric leaves the channels", () => {
    const { result, rerender } = renderHook(
      ({ rics }: { rics: readonly string[] }) => useLinkedRicFilter(rics),
      { initialProps: { rics: ["BARC.L", "AAL.L"] } },
    );
    act(() => result.current[1]("BARC.L"));
    expect(result.current[0]).toBe("BARC.L");
    rerender({ rics: ["BARC.L"] });
    expect(result.current[0]).toBe("BARC.L");
    rerender({ rics: ["AAL.L"] });
    expect(result.current[0]).toBeUndefined();
  });

  test("andFilters skips empty clauses", () => {
    expect(andFilters("", "")).toBe("");
    expect(andFilters('status in ["NEW"]', "")).toBe('status in ["NEW"]');
    expect(andFilters('status in ["NEW"]', 'ric = "X.L"')).toBe(
      'status in ["NEW"] and ric = "X.L"',
    );
  });
});
