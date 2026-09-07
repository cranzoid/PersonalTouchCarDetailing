import { requirePageStaff } from "@/lib/auth/page";
import { BlogEditor } from "../blog-editor";

export default async function NewBlogPostPage() {
  await requirePageStaff("manage_marketing");
  return <div className="max-w-[92rem]"><header className="mb-6"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Blog</p><h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">New article</h1></header><BlogEditor initial={{ slug: "", title: "", excerpt: "", content: "", seoTitle: "", seoDescription: "", status: "draft" }} /></div>;
}
