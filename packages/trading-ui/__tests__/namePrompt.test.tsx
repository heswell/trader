import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NamePrompt, watchlistNameError } from "../src";

afterEach(cleanup);

const renderPrompt = (
  validate?: (name: string) => string | undefined,
  initialName?: string,
) => {
  const onConfirm = mock();
  const onClose = mock();
  render(
    <NamePrompt
      initialName={initialName}
      onClose={onClose}
      onConfirm={onConfirm}
      title="New watchlist"
      validate={validate}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Name" });
  const confirm = screen.getByRole("button", { name: "Create" });
  return { confirm, input, onClose, onConfirm };
};

describe("NamePrompt", () => {
  test("a blank name disables Create without an error", () => {
    const { confirm } = renderPrompt();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Enter a name")).toBeNull();
  });

  test("Create confirms the trimmed name and closes", () => {
    const { confirm, input, onClose, onConfirm } = renderPrompt();
    fireEvent.change(input, { target: { value: "  Energy  " } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("Energy");
    expect(onClose).toHaveBeenCalled();
  });

  test("Enter confirms a valid name", () => {
    const { input, onClose, onConfirm } = renderPrompt();
    fireEvent.change(input, { target: { value: "Tech" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("Tech");
    expect(onClose).toHaveBeenCalled();
  });

  test("an invalid name shows the error and does not confirm", () => {
    const { confirm, input, onConfirm } = renderPrompt((name) =>
      name === "Taken" ? "Already taken" : undefined,
    );
    fireEvent.change(input, { target: { value: "Taken" } });
    expect(screen.getByText("Already taken")).toBeTruthy();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("starts from initialName", () => {
    const { input } = renderPrompt(undefined, "Old name");
    expect((input as HTMLInputElement).value).toBe("Old name");
  });
});

describe("watchlistNameError", () => {
  const lists = [{ id: "energy", name: "Energy", rics: [] }];
  test("blank and duplicate names, ignoring case and spaces", () => {
    expect(watchlistNameError("  ", lists)).toBe("Enter a name");
    expect(watchlistNameError(" energy ", lists)).toBe(
      "A watchlist called energy already exists",
    );
    expect(watchlistNameError("Tech", lists)).toBeUndefined();
  });
  test("a list may keep its own name when renamed", () => {
    expect(watchlistNameError("Energy", lists, "energy")).toBeUndefined();
  });
});

describe("no browser dialogs", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory()
        ? sources(path)
        : /\.tsx?$/.test(entry)
          ? [path]
          : [];
    });
  test("trading-ui never calls prompt, alert or confirm", () => {
    const offenders = sources(join(import.meta.dir, "../src")).filter((file) =>
      /\b(?:prompt|alert|confirm)\(\s*["'`]/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
