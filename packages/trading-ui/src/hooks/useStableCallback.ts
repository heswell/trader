import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always calls the latest
 * `callback`. Use it for vuu `Table` props that feed useDataSource's effect
 * (`onSelect`): if one changes while the viewport is still subscribing (a
 * cold start, or resubscribing after a reconnect) vuu-table throws "a
 * resumed dataSource must have a tableSchema" (trader upstream issue 87).
 */
export const useStableCallback = <Args extends unknown[], R>(
  callback: (...args: Args) => R,
): ((...args: Args) => R) => {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
};
