import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { VuuAggregation, VuuGroupBy } from "@vuu-ui/vuu-protocol-types";

/**
 * Group (or ungroup) a data source a vuu Table shows.
 *
 * The Table drops its group column only when an ungroup comes back
 * confirmed. The remote VuuDataSource confirms once the server acks the
 * change, but the local test-data source never does, so ungrouping left an
 * empty group column and lost the grouped columns (docs/upstream-issues.md,
 * 120). After an ungroup this tells the Table it is confirmed.
 */
export const applyGrouping = (
  dataSource: DataSource,
  groupBy: VuuGroupBy,
  aggregations: VuuAggregation[],
) => {
  const wasGrouped = (dataSource.groupBy?.length ?? 0) > 0;
  dataSource.groupBy = groupBy;
  dataSource.aggregations = aggregations;
  if (wasGrouped && groupBy.length === 0) {
    dataSource.emit("config", dataSource.config, dataSource.range, true);
  }
};
