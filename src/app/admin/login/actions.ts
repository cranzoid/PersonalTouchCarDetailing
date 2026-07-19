"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { createStaffSession, destroyStaffSession } from "@/lib/auth/session";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export type LoginResult = { ok: false; error: string };

export async function loginAction(_prev: unknown, formData: FormData): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  // Uniform error message — never reveal whether the account exists.
  const invalid: LoginResult = { ok: false, error: "Invalid email or password" };
  if (!parsed.success) return invalid;

  const rows = await db()
    .select()
    .from(schema.staffUsers)
    .where(eq(schema.staffUsers.email, parsed.data.email))
    .limit(1);
  const user = rows[0];
  if (!user || !user.active) return invalid;
  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) return invalid;

  const h = await headers();
  await createStaffSession(user.id, {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await destroyStaffSession();
  redirect("/admin/login");
}
