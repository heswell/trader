import { Button } from "@salt-ds/core";
import type { Filter } from "@vuu-ui/vuu-filter-types";
import type { ColumnDescriptor } from "@vuu-ui/vuu-table-types";
import { quickFilterChipLabel } from "./columnSetMeta";

const classBase = "tradingInstrumentGrid";

export interface AlsoAppliedProps {
  columns: readonly ColumnDescriptor[];
  filters: readonly { column: string; filter: Filter }[];
  onClear: (column: string) => void;
}

/**
 * Quick filter values on fields the column set in view doesn't show: they
 * still apply, as chips under the filter bar, each with a clear button.
 */
export const AlsoApplied = ({
  columns,
  filters,
  onClear,
}: AlsoAppliedProps) => (
  <fieldset className={`${classBase}-alsoApplied`}>
    <legend
      className={`${classBase}-alsoAppliedLabel`}
      title="Quick filters on fields this column set doesn't show"
    >
      Also applied
    </legend>
    {filters.map(({ column, filter }) => {
      const label = quickFilterChipLabel(column, filter, columns);
      return (
        <span className={`${classBase}-chip`} key={column}>
          <span className={`${classBase}-chipLabel`}>{label}</span>
          <Button
            appearance="transparent"
            aria-label={`Clear ${label}`}
            className={`${classBase}-chipClear`}
            onClick={() => onClear(column)}
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="8"
              viewBox="0 0 16 16"
              width="8"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
          </Button>
        </span>
      );
    })}
  </fieldset>
);
