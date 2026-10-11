import { expect, test } from "bun:test";
import type { VuuRpcServiceRequest } from "@vuu-ui/vuu-protocol-types";
import { RpcName, tradingRpcRequest } from "../src";

test("typed requests are valid vuu-ui RPC_REQUEST messages", () => {
  const msg: VuuRpcServiceRequest = tradingRpcRequest(
    RpcName.CreateOrder,
    {
      account: "ACC1",
      ric: "VOD.L",
      side: "BUY",
      ordType: "MARKET",
      quantity: 100,
    },
    "vp-1",
  );
  expect(msg.rpcName).toBe("createOrder");
});
