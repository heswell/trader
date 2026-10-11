import { TableDef } from "@heswell/vuu-server";

export const HELLO_MODULE_NAME = "HELLO";

export const helloPrices = TableDef({
  name: "helloPrices",
  keyField: "ric",
  columns: [
    { name: "ric", dataType: "string" },
    { name: "description", dataType: "string" },
    { name: "bid", dataType: "double" },
    { name: "ask", dataType: "double" },
    { name: "last", dataType: "double" },
    { name: "ticks", dataType: "int" },
  ],
});
