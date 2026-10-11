import { useData } from "@vuu-ui/core";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { useEffect, useMemo } from "react";

const columnNames = ["ric", "description", "bid", "ask", "last", "ticks"];

const config: TableConfig = {
  columns: [
    { name: "ric", width: 100 },
    { name: "description", width: 180 },
    { name: "bid" },
    { name: "ask" },
    { name: "last" },
    { name: "ticks" },
  ],
};

const Hello = () => {
  const { VuuDataSource } = useData();

  const dataSource = useMemo(
    () =>
      new VuuDataSource({
        columns: columnNames,
        table: { module: "HELLO", table: "helloPrices" },
      }),
    [VuuDataSource],
  );

  useEffect(() => () => dataSource.unsubscribe(), [dataSource]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <h3 style={{ margin: 8 }}>Hello prices</h3>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Table config={config} dataSource={dataSource} />
      </div>
    </div>
  );
};

export default Hello;
