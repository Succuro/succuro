import type { ConnectorKind } from "@/domain/connectors";
import type { Adapter } from "./adapter";
import { resendAdapter } from "./resend";

const adapters: Record<ConnectorKind, Adapter> = { resend: resendAdapter };

/** The adapter that talks to a connector's service. */
export const adapterOf = (kind: ConnectorKind): Adapter => adapters[kind];
