import { LIMIT_STATE_LABEL } from "./limitFormat";
import { useLimitsCss } from "./useLimitsCss";

/** A LimitState as a badge: OK plain, Warning outlined, Soft and Hard solid. */
export const LimitStateBadge = ({ state }: { state: string }) => {
  useLimitsCss();
  return state ? (
    <span className={`tradingLimitState tradingLimitState-${state}`}>
      {LIMIT_STATE_LABEL[state] ?? state}
    </span>
  ) : null;
};
