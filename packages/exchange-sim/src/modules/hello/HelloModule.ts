import { ModuleFactory } from "@heswell/vuu-server";
import { HELLO_MODULE_NAME, helloPrices } from "./HelloTableDefs";
import { HelloPricesProvider } from "./providers/HelloPricesProvider";

export const HelloModule = () =>
  ModuleFactory.withNameSpace(HELLO_MODULE_NAME)
    .addTable(helloPrices, (table) => new HelloPricesProvider(table))
    .asModule();
