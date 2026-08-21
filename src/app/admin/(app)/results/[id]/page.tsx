import { notFound } from "next/navigation";
import { requirePageStaff } from "@/lib/auth/page";
import { CaseStudyEditor } from "../case-study-editor";
import { getCaseStudyEditorData, getEditorOptions } from "../data";

export const dynamic = "force-dynamic";

export default async function EditCaseStudyPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_marketing");
  const { id } = await params;
  const [initial, options] = await Promise.all([getCaseStudyEditorData(id), getEditorOptions()]);
  if (!initial) notFound();
  return (
    <div className="max-w-[92rem]">
      <header className="mb-6"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Case studies</p><h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Edit case study</h1></header>
      <CaseStudyEditor {...options} initial={initial} />
    </div>
  );
}
