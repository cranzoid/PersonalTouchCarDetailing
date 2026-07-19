import { schema, type Db } from "@/db";
import { newId } from "./id";

/**
 * Append an audit entry. Callers pass the same transaction handle used for the
 * mutation so the audit record commits atomically with the change.
 */
export async function audit(
  tx: Pick<Db, "insert">,
  entry: {
    actorType: "staff" | "customer" | "system";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
    ip?: string;
  },
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    id: newId("aud"),
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason,
    ip: entry.ip,
  });
}
