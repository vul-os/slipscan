/**
 * Hono app type: Bindings (env) + Variables (per-request context set by
 * middleware). Every module's routes use `Hono<AppEnv>`.
 */
import type { Env } from "../bindings";
import type { Role } from "./schema";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string; // set by requireAuth
    email?: string; // set by requireAuth (from access-token claim)
    orgRole?: Role; // set by requireMember/requireAdmin
  };
};
