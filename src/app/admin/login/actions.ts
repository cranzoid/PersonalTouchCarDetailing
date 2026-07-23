"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { createStaffSession, destroyStaffSession } from "@/lib/auth/session";
import { consumeRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

// A real bcrypt hash keeps the failure path intentionally close to the cost
// of checking an existing account, so sign-in timing does not reveal which
// staff email addresses exist.
const DUMMY_PASSWORD_HASH = "$2b$12$HAOV1eDnzLBLpumzb.JbTeAxbBTs1AJN9aNUekHVlaZr7lcvt1hGC";

export type LoginResult = { ok: false; error: string };

export async function loginAction(_prev: unknown, formData: FormData): Promise<LoginResult> {
  const rate = await consumeRateLimit("admin-login", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) {
    return { ok: false, error: "Too many sign-in attempts. Please wait a few minutes and try again." };
  }
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
  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.active || !valid) return invalid;

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
