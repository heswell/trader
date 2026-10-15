import { useRef } from "react";
import type { DepthLevel } from "./useMarketData";
import { priceKey } from "./useMarketData";

export type FlashDirection = "up" | "down" | "new";
export interface LevelFlash {
  direction: FlashDirection;
  /** Changes on every flash; use as a React key to restart a CSS animation. */
  seq: number;
}

/**
 * Detect quantity changes per (side, price) between depth updates. Returns
 * flashes for the levels that changed in the latest update. Idempotent per
 * `version`, so StrictMode double renders don't swallow flashes. Resets
 * when `resetKey` (e.g. the ric) changes, so a switch doesn't flash.
 */
export const useLevelFlash = (
  levels: readonly DepthLevel[],
  version: number,
  resetKey: unknown,
): Map<string, LevelFlash> => {
  const state = useRef({
    resetKey: undefined as unknown,
    version: -1,
    sizes: new Map<string, number>(),
    flashes: new Map<string, LevelFlash>(),
    seq: 0,
  });
  const s = state.current;
  if (s.resetKey !== resetKey) {
    s.resetKey = resetKey;
    s.sizes = new Map();
    s.flashes = new Map();
    s.version = version;
    for (const l of levels) s.sizes.set(levelKey(l.side, l.price), l.size);
    return s.flashes;
  }
  if (s.version === version) return s.flashes;
  s.version = version;
  const isFirst = s.sizes.size === 0;
  const sizes = new Map<string, number>();
  const flashes = new Map(s.flashes);
  for (const l of levels) {
    const key = levelKey(l.side, l.price);
    sizes.set(key, l.size);
    const prev = s.sizes.get(key);
    if (isFirst) continue;
    if (prev === undefined) {
      flashes.set(key, { direction: "new", seq: ++s.seq });
    } else if (prev !== l.size) {
      flashes.set(key, {
        direction: l.size > prev ? "up" : "down",
        seq: ++s.seq,
      });
    }
  }
  for (const key of flashes.keys()) if (!sizes.has(key)) flashes.delete(key);
  s.sizes = sizes;
  s.flashes = flashes;
  return flashes;
};

/** Key of a depth level (`side|price`) used by useLevelFlash. */
export const levelKey = (side: string, price: number) =>
  `${side}|${priceKey(price)}`;
