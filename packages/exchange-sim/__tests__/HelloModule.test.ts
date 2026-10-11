import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type DataTable,
  LifecycleContainer,
  LoginTokenService,
  VuuServer,
  VuuServerConfig,
  VuuWebSocketOptions,
} from "@heswell/vuu-server";
import { HelloModule } from "../src/modules/hello/HelloModule";
import { HELLO_INSTRUMENTS } from "../src/modules/hello/providers/HelloPricesProvider";

describe("HelloModule", () => {
  let lifecycle: LifecycleContainer;
  let server: VuuServer;

  beforeAll(async () => {
    lifecycle = new LifecycleContainer();
    server = new VuuServer(
      VuuServerConfig(
        VuuWebSocketOptions().withWsPort(0).withSslDisabled(),
        {},
        LoginTokenService(),
      ).withModule(HelloModule()),
      lifecycle,
    );
    await lifecycle.start();
  });

  afterAll(async () => {
    await lifecycle.stop();
  });

  test("registers helloPrices in the HELLO namespace", () => {
    expect(server.tableContainer.getDefinedTables()).toEqual([
      { module: "HELLO", table: "helloPrices" },
    ]);
  });

  test("seeds instruments and ticks them", async () => {
    const table = server.tableContainer.getTable<DataTable>("helloPrices");
    expect(table.rows.length).toBe(HELLO_INSTRUMENTS.length);
    const totalTicks = () =>
      table.rows.reduce((sum, row) => sum + (row[5] as number), 0);
    const before = totalTicks();
    await Bun.sleep(700);
    expect(totalTicks()).toBeGreaterThan(before);
  });
});
