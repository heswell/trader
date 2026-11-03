import { useRef } from "react";

export interface PriceFlash {
  direction: "up" | "down";
  /** Changes on every move; use as a React key to restart the animation. */
  seq: number;
}

/**
 * The direction of the latest change of `value` for `key` (e.g. a ric).
 * No flash on the first value, or when `key` changes (a row reused for
 * another instrument). Idempotent per value, so StrictMode double renders
 * do not lose or repeat a flash.
 */
export const usePriceFlash = (
  key: string | undefined,
  value: unknown,
): PriceFlash | undefined => {
  const state = useRef<{
    key: string | undefined;
    value: unknown;
    flash: PriceFlash | undefined;
    seq: number;
  }>({ key, value, flash: undefined, seq: 0 });
  const s = state.current;
  if (s.key !== key) {
    s.key = key;
    s.value = value;
    s.flash = undefined;
  } else if (
    typeof value === "number" &&
    typeof s.value === "number" &&
    value !== s.value
  ) {
    s.flash = { direction: value > s.value ? "up" : "down", seq: ++s.seq };
    s.value = value;
  } else if (typeof s.value !== "number") {
    s.value = value;
  }
  return s.flash;
};
