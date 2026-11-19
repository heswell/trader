import {
  Button,
  Tab,
  TabBar,
  TabList,
  TabPanel,
  Tabs,
  TabTrigger,
  Text,
} from "@salt-ds/core";
import {
  type ColumnModel,
  ColumnPicker,
  type ColumnSetModel,
} from "@vuu-ui/vuu-table-extras";
import { type ItemDescriptor, ItemPicker } from "@vuu-ui/vuu-ui-controls";
import { useEffect, useState } from "react";

const toItems = (names: readonly string[], items: readonly ItemDescriptor[]) =>
  names
    .map((name) => items.find((item) => item.name === name))
    .filter((item): item is ItemDescriptor => item !== undefined);

/** The quick filter fields, in order; holds its own selection (context panel content is not re-rendered). */
const QuickFilterFieldsPicker = ({
  allItems,
  defaultSelected,
  onChange,
  resetColumns,
}: {
  allItems: ItemDescriptor[];
  defaultSelected: ItemDescriptor[];
  onChange: (columns: string[]) => void;
  resetColumns: string[];
}) => {
  const [selected, setSelected] = useState(defaultSelected);
  const change = (columns: string[]) => {
    setSelected(toItems(columns, allItems));
    onChange(columns);
  };
  return (
    <div className={`${classBase}-quickFilters`}>
      <ItemPicker
        allItems={allItems}
        itemTypeName="field"
        onSelectedItemsChange={(items) => change(items.map(({ name }) => name))}
        selectedItems={selected}
      />
      <div className={`${classBase}-footer`}>
        <Button
          appearance="transparent"
          onClick={() => change(resetColumns)}
          sentiment="accented"
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
};

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
 * quick filters of the column set in view (until vuu-ui's ColumnPicker
 * takes extra tabs, upstream U2). A field can be a quick filter without
 * being a column. Both tabs follow the active column set.
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
  const [tab, setTab] = useState<string>(initialTab);
  const [setName, setSetName] = useState(columnSetModel.activeColumnSet?.name);
  useEffect(() => {
    const handler = () => setSetName(columnSetModel.activeColumnSet?.name);
    columnSetModel.on("change", handler);
    return () => {
      columnSetModel.removeListener("change", handler);
    };
  }, [columnSetModel]);

  const selected = toItems(getQuickFilterColumns(), quickFilterItems);

  return (
    <Tabs
      className={classBase}
      onChange={(_e, value) => setTab(value)}
      value={tab}
    >
      <TabBar divider inset>
        <TabList aria-label="Columns and quick filters">
          <Tab value="columns">
            <TabTrigger>Columns</TabTrigger>
          </Tab>
          <Tab value="quickFilters">
            <TabTrigger>Quick filters</TabTrigger>
          </Tab>
        </TabList>
      </TabBar>
      <TabPanel className={`${classBase}-panel`} value="columns">
        <ColumnPicker
          columnModel={columnModel}
          columnSetModel={columnSetModel}
        />
      </TabPanel>
      <TabPanel className={`${classBase}-panel`} value="quickFilters">
        <Text className={`${classBase}-note`} styleAs="label">
          {setName
            ? `The quick filters of ${setName}: switching column sets switches them too. A field need not be a column.`
            : "The quick filters in view. A field need not be a column."}
        </Text>
        <QuickFilterFieldsPicker
          allItems={quickFilterItems}
          defaultSelected={selected}
          // remount on a change of set: the picker holds its own selection
          key={setName ?? ""}
          onChange={onChangeQuickFilterColumns}
          resetColumns={defaultQuickFilterColumns}
        />
      </TabPanel>
    </Tabs>
  );
};
