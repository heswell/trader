import { RejectReason } from "@heswell/trading-schemas";

/**
 * Trading server role for simulator monitoring and control: the sim-admin
 * tables (simBooks, bots, botParams) and the exchange admin RPCs.
 */
export const SIM_ADMIN_ROLE = "sim-admin";

export type SimPermissionMode = "auto" | "strict";

export interface SimUser {
  name?: string;
  authorizations?: readonly string[];
}

/**
 * True when `user` may monitor and control the simulator. "auto" also lets
 * in users with no roles at all, which is what dev / permissive auth gives
 * (the same rule as the OMS's auto mode); a user with other roles but not
 * sim-admin is refused in both modes.
 */
export const canAdminSim = (
  user: SimUser | undefined,
  mode: SimPermissionMode = "auto",
) => {
  const roles = user?.authorizations ?? [];
  if (roles.includes(SIM_ADMIN_ROLE)) return true;
  return mode === "auto" && roles.length === 0;
};

export const simAdminDenied = (user: SimUser | undefined) =>
  `${RejectReason.PermissionDenied}: ${user?.name ?? "user"} needs the ${SIM_ADMIN_ROLE} role`;
