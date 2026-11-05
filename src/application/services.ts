import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";

/** What the use cases that reach outside the app run with: the database, the instance's settings, the network and the clock. */
export interface Services {
  db: Database;
  settings: Env;
  fetch: typeof fetch;
  now: () => Date;
}
