import { requirePageStaff } from "@/lib/auth/page";
import { CaseStudyEditor } from "../case-study-editor";
import { getEditorOptions } from "../data";

export const dynamic = "force-dynamic";

export default async function NewCaseStudyPage() {
  await requirePageStaff("manage_marketing");
  const options = await getEditorOptions();
  return (
    <div className="max-w-[92rem]">
      <header className="mb-6"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Case studies</p><h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Draft a genuine customer result</h1></header>
      <CaseStudyEditor
        {...options}
        initial={{ id: undefined, slug: "", title: "", summary: "", challenge: "", process: "", outcome: "", primaryServiceId: "", relatedServiceIds: [], media: [], consentConfirmed: false, privacyChecked: false, status: "draft" }}
      />
    </div>
  );
}
