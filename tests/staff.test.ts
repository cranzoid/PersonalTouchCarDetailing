import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_staff_test_owner",
    name: "Test Owner",
    email: "owner@example.com",
    role: "owner" as const,
  },
  requireStaff: vi.fn(),
}));
auth.requireStaff.mockResolvedValue(auth.actor);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: auth.requireStaff,
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { verifyPassword } from "../src/lib/auth/password";
import { newId } from "../src/lib/id";
import {
  createStaffAction,
  resetStaffPasswordAction,
  updateStaffSchedulingAction,
  updateStaffAction,
} from "../src/app/admin/(app)/staff/actions";
import {
  createScheduleBlockAction,
  removeScheduleBlockAction,
} from "../src/app/admin/(app)/settings/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE staff_sessions, staff_schedules, schedule_blocks, resources,
             staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: auth.actor.id,
    name: auth.actor.name,
    email: auth.actor.email,
    passwordHash: "not-used-in-tests",
    role: "owner",
    active: true,
  });
  auth.requireStaff.mockClear();
  auth.requireStaff.mockResolvedValue(auth.actor);
}

async function insertStaff(input: { role?: string; active?: boolean; email?: string } = {}) {
  const id = newId("usr");
  await db().insert(schema.staffUsers).values({
    id,
    name: "Second Staff",
    email: input.email ?? `${id}@example.com`,
    passwordHash: "old-password-hash",
    role: input.role ?? "manager",
    active: input.active ?? true,
  });
  return id;
}

async function insertSession(staffUserId: string) {
  const id = newId("ses");
  await db().insert(schema.staffSessions).values({
    id,
    tokenHash: `hash_${id}`,
    staffUserId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return id;
}

describe("owner staff management", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("creates one normalized staff account and handles duplicate email safely", async () => {
    const request = {
      name: "New Receptionist",
      email: "NEW.STAFF@Example.com",
      role: "reception" as const,
      password: "a-secure-password-123",
    };
    const created = await createStaffAction(request);
    expect(created.ok).toBe(true);
    expect(auth.requireStaff).toHaveBeenCalledWith("manage_staff");

    const duplicate = await createStaffAction({ ...request, name: "Duplicate" });
    expect(duplicate).toEqual({ ok: false, error: "A staff user with that email already exists" });

    const users = await db()
      .select()
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.email, "new.staff@example.com"));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: request.name, role: "reception", active: true });
    expect(await verifyPassword(request.password, users[0].passwordHash)).toBe(true);

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "staff.created"));
    expect(audits).toHaveLength(1);
  });

  it("rejects short passwords before creating an account", async () => {
    const result = await createStaffAction({
      name: "Short Password",
      email: "short@example.com",
      role: "technician",
      password: "too-short",
    });
    expect(result.ok).toBe(false);
    expect(await db().select().from(schema.staffUsers)).toHaveLength(1);
  });

  it("prevents self-deactivation and removal of the last active owner", async () => {
    expect(
      await updateStaffAction({ staffUserId: auth.actor.id, role: "owner", active: false }),
    ).toEqual({ ok: false, error: "You cannot deactivate your own account" });
    expect(
      await updateStaffAction({ staffUserId: auth.actor.id, role: "manager", active: true }),
    ).toEqual({ ok: false, error: "At least one active owner account is required" });

    await insertStaff({ role: "owner" });
    expect(
      await updateStaffAction({ staffUserId: auth.actor.id, role: "manager", active: true }),
    ).toEqual({ ok: true });
    const [actor] = await db()
      .select()
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.id, auth.actor.id));
    expect(actor.role).toBe("manager");
  });

  it("revokes sessions on deactivation and does not duplicate an idempotent update audit", async () => {
    const targetId = await insertStaff();
    const sessionId = await insertSession(targetId);
    const request = { staffUserId: targetId, role: "manager" as const, active: false };

    expect(await updateStaffAction(request)).toEqual({ ok: true });
    expect(await updateStaffAction(request)).toEqual({ ok: true });

    const [target] = await db().select().from(schema.staffUsers).where(eq(schema.staffUsers.id, targetId));
    const [session] = await db().select().from(schema.staffSessions).where(eq(schema.staffSessions.id, sessionId));
    expect(target.active).toBe(false);
    expect(session.revokedAt).toBeInstanceOf(Date);

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "staff.updated"));
    expect(audits).toHaveLength(1);
  });

  it("resets a password, revokes sessions and audits without exposing the hash", async () => {
    const targetId = await insertStaff();
    const sessionId = await insertSession(targetId);
    const newPassword = "replacement-password-456";

    expect(await resetStaffPasswordAction({ staffUserId: targetId, password: newPassword })).toEqual({ ok: true });

    const [target] = await db().select().from(schema.staffUsers).where(eq(schema.staffUsers.id, targetId));
    const [session] = await db().select().from(schema.staffSessions).where(eq(schema.staffSessions.id, sessionId));
    expect(await verifyPassword(newPassword, target.passwordHash)).toBe(true);
    expect(session.revokedAt).toBeInstanceOf(Date);

    const [entry] = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "staff.password_reset"));
    expect(entry.entityId).toBe(targetId);
    expect(JSON.stringify(entry.after)).not.toContain(target.passwordHash);
  });

  it("normalizes skills, replaces weekly shifts, and records an audit trail", async () => {
    const targetId = await insertStaff({ role: "technician" });
    expect(await updateStaffSchedulingAction({
      staffUserId: targetId,
      skills: [" Ceramic ", "POLISHING", "ceramic"],
      shifts: [
        { weekday: 1, start: "08:30", end: "17:00" },
        { weekday: 3, start: "10:00", end: "18:30" },
      ],
    })).toEqual({ ok: true });

    const [target] = await db().select().from(schema.staffUsers)
      .where(eq(schema.staffUsers.id, targetId));
    const shifts = await db().select().from(schema.staffSchedules)
      .where(eq(schema.staffSchedules.staffUserId, targetId));
    expect(target.skills).toEqual(["ceramic", "polishing"]);
    expect(shifts.map(({ weekday, start, end }) => ({ weekday, start, end })))
      .toEqual(expect.arrayContaining([
        { weekday: 1, start: "08:30", end: "17:00" },
        { weekday: 3, start: "10:00", end: "18:30" },
      ]));

    const [entry] = await db().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, "staff.scheduling_updated"));
    expect(entry.entityId).toBe(targetId);
    expect(entry.actorId).toBe(auth.actor.id);
    expect(entry.after).toMatchObject({ skills: ["ceramic", "polishing"] });
  });

  it("rejects invalid and duplicate weekly shifts without changing the schedule", async () => {
    const targetId = await insertStaff({ role: "technician" });
    const duplicateDay = await updateStaffSchedulingAction({
      staffUserId: targetId,
      skills: [],
      shifts: [
        { weekday: 2, start: "08:00", end: "12:00" },
        { weekday: 2, start: "13:00", end: "17:00" },
      ],
    });
    const reversed = await updateStaffSchedulingAction({
      staffUserId: targetId,
      skills: [],
      shifts: [{ weekday: 2, start: "17:00", end: "08:00" }],
    });
    expect(duplicateDay).toEqual({ ok: false, error: "Only one shift per weekday is supported" });
    expect(reversed).toEqual({ ok: false, error: "Every shift start must be before its end" });
    expect(await db().select().from(schema.staffSchedules)).toHaveLength(0);
  });

  it("creates and removes an audited business closure", async () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    expect(await createScheduleBlockAction({
      type: "closure",
      startsLocal: `${future}T12:00`,
      endsLocal: `${future}T15:00`,
      reason: "Team training",
    })).toEqual({ ok: true });

    const [block] = await db().select().from(schema.scheduleBlocks);
    expect(block).toMatchObject({ staffUserId: null, resourceId: null, reason: "Team training" });
    expect(await removeScheduleBlockAction({ blockId: block.id })).toEqual({ ok: true });
    expect(await db().select().from(schema.scheduleBlocks)).toHaveLength(0);

    const actions = (await db().select().from(schema.auditLog)).map((entry) => entry.action);
    expect(actions).toContain("schedule_block.created");
    expect(actions).toContain("schedule_block.removed");
    expect(auth.requireStaff).toHaveBeenCalledWith("manage_settings");
  });
});
