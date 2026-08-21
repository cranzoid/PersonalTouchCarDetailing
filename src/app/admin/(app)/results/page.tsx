import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { StatusBadge } from "@/components/admin";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function CaseStudiesAdminPage() {
  await requirePageStaff("manage_marketing");
  const stories = await db()
    .select({
      id: schema.caseStudies.id,
      slug: schema.caseStudies.slug,
      title: schema.caseStudies.title,
      summary: schema.caseStudies.summary,
      status: schema.caseStudies.status,
      publishedAt: schema.caseStudies.publishedAt,
      updatedAt: schema.caseStudies.updatedAt,
      serviceName: schema.services.name,
    })
    .from(schema.caseStudies)
    .innerJoin(schema.services, eq(schema.services.id, schema.caseStudies.primaryServiceId))
    .orderBy(desc(schema.caseStudies.updatedAt));

  return (
    <div className="max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Local proof</p>
          <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Case studies</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#687B8E]">Draft and publish customer-approved Hamilton job stories. Every published story must pass consent, privacy and completeness checks.</p>
        </div>
        <Link href="/admin/results/new" className="inline-flex min-h-11 items-center rounded-xl bg-[#0B2A4A] px-4 text-sm font-bold text-white shadow-sm">New case study</Link>
      </header>

      <section className="mt-6 rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm">
        {stories.length === 0 ? (
          <div className="rounded-xl bg-[#F5F7FA] px-5 py-12 text-center">
            <h2 className="font-bold text-[#0B2A4A]">No case studies yet</h2>
            <p className="mt-2 text-sm text-[#687B8E]">Start with a completed job that has explicit photo consent and a result you can document accurately.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]"><tr><th className="py-2 pr-4">Story</th><th className="py-2 pr-4">Service</th><th className="py-2 pr-4">Status</th><th className="py-2">Updated</th></tr></thead>
              <tbody className="divide-y divide-[#EBF0F5]">
                {stories.map((story) => (
                  <tr key={story.id}>
                    <td className="py-4 pr-4">
                      <Link href={`/admin/results/${story.id}`} className="font-bold text-[#0B2A4A] hover:underline">{story.title}</Link>
                      <p className="mt-1 max-w-xl truncate text-xs text-[#75869A]">/{story.slug} · {story.summary || "Draft summary not added"}</p>
                    </td>
                    <td className="py-4 pr-4 text-[#4E6377]">{story.serviceName}</td>
                    <td className="py-4 pr-4"><StatusBadge status={story.status} /></td>
                    <td className="py-4 text-[#75869A]">{story.updatedAt.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
