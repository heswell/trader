import { Text } from "@salt-ds/core";
import { ContextPanelColumnsPicker } from "@vuu-ui/vuu-filters";
import {
  ConfigPanelTab,
  type ColumnModel,
  ColumnPicker,
  type ColumnSetModel,
  TabbedConfigPanel,
} from "@vuu-ui/vuu-table-extras";
import type { ItemDescriptor } from "@vuu-ui/vuu-ui-controls";
import { useEffect, useState } from "react";

const toItems = (names: readonly string[], items: readonly ItemDescriptor[]) =>
  names
    .map((name) => items.find((item) => item.name === name))
    .filter((item): item is ItemDescriptor => item !== undefined);

const classBase = "tradingGridColumnsPanel";

export type GridColumnsTab = "columns" | "quickFilters";

export interface GridColumnsPanelProps {
  columnModel: ColumnModel;
  columnSetModel: ColumnSetModel;
  /** Every field a quick filter can be on (shown as a column or not). */
  quickFilterItems: ItemDescriptor[];
  /** The quick filter fields in view now (read when the set changes). */
  getQuickFilterColumns: () => string[];
  /** What Reset to default restores. */
  defaultQuickFilterColumns: string[];
  onChangeQuickFilterColumns: (columns: string[]) => void;
  initialTab?: GridColumnsTab;
}

/**
 * The grid's column picker in the context panel, with a second tab for the
 * quick filters of the column set in view. A field can be a quick filter
 * without being a column. Both tabs follow the active column set.
 */
export const GridColumnsPanel = ({
  columnModel,
  columnSetModel,
  defaultQuickFilterColumns,
  getQuickFilterColumns,
  initialTab = "columns",
  onChangeQuickFilterColumns,
  quickFilterItems,
}: GridColumnsPanelProps) => {
  const [setName, setSetName] = useState(columnSetModel.activeColumnSet?.name);
  useEffect(() => {
    const handler = () => setSetName(columnSetModel.activeColumnSet?.name);
    columnSetModel.on("change", handler);
    return () => {
      columnSetModel.removeListener("change", handler);
    };
  }, [columnSetModel]);

  return (
    <TabbedConfigPanel
      className={classBase}
      defaultValue={initialTab}
      tabListLabel="Columns and quick filters"
    >
      <ConfigPanelTab
        className={`${classBase}-panel`}
        label="Columns"
        value="columns"
      >
        <ColumnPicker
          columnModel={columnModel}
          columnSetModel={columnSetModel}
        />
      </ConfigPanelTab>
      <ConfigPanelTab
        className={`${classBase}-panel`}
        label="Quick filters"
        value="quickFilters"
      >
        <Text className={`${classBase}-note`} styleAs="label">
          {setName
            ? `The quick filters of ${setName}: switching column sets switches them too. A field need not be a column.`
            : "The quick filters in view. A field need not be a column."}
        </Text>
        <ContextPanelColumnsPicker
          allItems={quickFilterItems}
          className={`${classBase}-quickFilters`}
          defaultSelectedItems={toItems(
            getQuickFilterColumns(),
            quickFilterItems,
          )}
          itemTypeName="field"
          // remount on a change of set: the picker holds its own selection
          key={setName ?? ""}
          onChangeColumns={onChangeQuickFilterColumns}
          resetColumns={defaultQuickFilterColumns}
        />
      </ConfigPanelTab>
    </TabbedConfigPanel>
  );
};
