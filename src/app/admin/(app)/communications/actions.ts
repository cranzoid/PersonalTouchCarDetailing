"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { messageTemplateUpdateSchema, validateTemplateContent } from "./template-contracts";

export type MessageTemplateActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateMessageTemplateAction(
  raw: unknown,
): Promise<MessageTemplateActionResult> {
  try {
    const staff = await requireStaff("manage_settings");
    const parsed = messageTemplateUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Invalid template values — check the subject and body." };
    }
    const input = parsed.data;

    return await db().transaction(async (tx): Promise<MessageTemplateActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.messageTemplates)
        .where(eq(schema.messageTemplates.id, input.templateId))
        .for("update");
      if (!before) return { ok: false, error: "Message template not found." };

      const contentError = validateTemplateContent(before.key, input);
      if (contentError) return { ok: false, error: contentError };

      const after = {
        channel: input.channel,
        subject: input.channel === "sms" ? null : input.subject,
        body: input.body,
        active: input.active,
      };
      await tx
        .update(schema.messageTemplates)
        .set({ ...after, updatedAt: new Date() })
        .where(eq(schema.messageTemplates.id, before.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "message_template.updated",
        entityType: "message_template",
        entityId: before.id,
        before: {
          key: before.key,
          channel: before.channel,
          subject: before.subject,
          body: before.body,
          active: before.active,
        },
        after: { key: before.key, ...after },
      });

      revalidatePath("/admin/communications");
      return { ok: true };
    });
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("updateMessageTemplateAction failed", error);
    return { ok: false, error: "Something went wrong saving the template." };
  }
}
