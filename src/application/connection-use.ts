import type { Tried } from "@/domain/tried";
import { checkConnection } from "./connections";
import type { Services } from "./services";

/** Asks the service whether the connection still works, and says so. */
export async function tryCheck(services: Services, workspaceId: string, connectionId: string): Promise<Tried> {
  const checked = await checkConnection(services, workspaceId, connectionId);
  if (!checked) return { ok: false, error: "This connection no longer exists." };
  return checked.status === "connected" ? { ok: true, said: `${checked.label} answers.` } : { ok: false, error: checked.lastError ?? "The service didn’t answer." };
}
