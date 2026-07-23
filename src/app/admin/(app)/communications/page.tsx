import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { TemplateEditor } from "./template-editor";
import { extractTemplateVariables, TEMPLATE_VARIABLES } from "./template-contracts";

export const dynamic = "force-dynamic";

export default async function CommunicationsPage() {
  await requirePageStaff("manage_settings");
  const templates = await db()
    .select()
    .from(schema.messageTemplates)
    .orderBy(asc(schema.messageTemplates.key));

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Communications</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-400">
        Edit the message templates already configured for customer notifications. Changes are
        audited; template keys cannot be renamed or created here.
      </p>
      <div className="mt-4 rounded-xl border border-ink-800 bg-ink-900/40 p-4 text-sm text-ink-300">
        <p className="font-medium text-white">Using variables</p>
        <p className="mt-1">
          Insert a listed value with double braces, for example <code className="text-accent-300">{"{{firstName}}"}</code>.
          Only variables shown for that template are supplied by its current workflow.
        </p>
      </div>

      <div className="mt-6 space-y-5">
        {templates.map((template) => (
          <TemplateEditor
            key={template.id}
            template={{
              id: template.id,
              key: template.key,
              channel: template.channel,
              subject: template.subject,
              body: template.body,
              active: template.active,
              updatedAt: template.updatedAt.toISOString(),
            }}
            supportedVariables={TEMPLATE_VARIABLES[template.key] ?? null}
            detectedVariables={extractTemplateVariables(template.subject, template.body)}
          />
        ))}
        {templates.length === 0 && (
          <div className="rounded-xl border border-ink-800 px-4 py-10 text-center text-sm text-ink-400">
            No message templates are configured. This page does not create templates.
          </div>
        )}
      </div>
    </div>
  );
}
