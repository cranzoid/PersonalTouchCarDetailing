import "server-only";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { StaffRole } from "@/lib/types";
import { roleHas, type Permission } from "./permissions";

const COOKIE_NAME = "ptcd_session";
const SESSION_TTL_HOURS = 12;

export type StaffContext = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createStaffSession(
  staffUserId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
  await db().insert(schema.staffSessions).values({
    id: `ses_${randomBytes(10).toString("hex")}`,
    tokenHash: hashToken(token),
    staffUserId,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroyStaffSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) {
    await db()
      .update(schema.staffSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.staffSessions.tokenHash, hashToken(token)));
  }
  cookieStore.delete(COOKIE_NAME);
}

/** Returns the authenticated, active staff member or null. */
export async function getStaff(): Promise<StaffContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const rows = await db()
    .select({
      id: schema.staffUsers.id,
      name: schema.staffUsers.name,
      email: schema.staffUsers.email,
      role: schema.staffUsers.role,
      active: schema.staffUsers.active,
    })
    .from(schema.staffSessions)
    .innerJoin(schema.staffUsers, eq(schema.staffSessions.staffUserId, schema.staffUsers.id))
    .where(
      and(
        eq(schema.staffSessions.tokenHash, hashToken(token)),
        gt(schema.staffSessions.expiresAt, new Date()),
        isNull(schema.staffSessions.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.active) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role as StaffRole };
}

export class AuthError extends Error {
  constructor(message = "Not authorized") {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * The server-side authorization gate. Every admin server action and route
 * handler calls this; it throws when unauthenticated or missing permission.
 */
export async function requireStaff(...permissions: Permission[]): Promise<StaffContext> {
  const staff = await getStaff();
  if (!staff) throw new AuthError("Not signed in");
  for (const p of permissions) {
    if (!roleHas(staff.role, p)) throw new AuthError(`Missing permission: ${p}`);
  }
  return staff;
}
