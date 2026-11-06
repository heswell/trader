import type { RejectReason } from "@heswell/trading-schemas";

/** An admin action refused: `reason` becomes the RPC error code. */
export class ExchangeAdminError extends Error {
  constructor(
    readonly reason: RejectReason,
    text: string,
  ) {
    super(text);
  }
}
