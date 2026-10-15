import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_undo_checkin_test",
  name: "Test Owner",
  email: "undo-checkin@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  checkInAppointmentAction,
  transitionJobAction,
  undoCheckInAction,
} from "../src/app/admin/(app)/jobs/actions";

/** A vehicle checked in by mistake has to go back to being a booking. */

let customerId: string;
let vehicleId: string;

async function appointment(status: string) {
  const id = newId("apt");
  const startsAt = new Date(Date.now() + 3_600_000);
  await db().insert(schema.appointments).values({
    id,
    customerId,
    vehicleId,
    status,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 90 * 60_000),
    subtotalCents: 10000,
    taxCents: 1300,
    taxRateBp: 1300,
    totalCents: 11300,
    durationMin: 60,
  });
  return id;
}

async function checkedIn(status = "confirmed") {
  const appointmentId = await appointment(status);
  const res = await checkInAppointmentAction({ appointmentId });
  if (!res.ok) throw new Error(res.error);
  return { appointmentId, jobId: res.jobId };
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, additional_work_requests,
     qc_checklists, inspection_findings, inspections, files, jobs, appointment_services,
     appointments, vehicles, customers, audit_log, staff_users RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Wrong", lastName: "Car", email: "undo-checkin@example.com",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId, customerId, make: "Honda", model: "Civic", category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("undoCheckInAction", () => {
  it("deletes the job and puts the appointment back to confirmed", async () => {
    const { appointmentId, jobId } = await checkedIn("confirmed");

    const res = await undoCheckInAction({ jobId });
    expect(res).toEqual({ ok: true, appointmentId });

    expect(await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId))).toHaveLength(0);
    const [appt] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appt.status).toBe("confirmed");
    expect(appt.jobId).toBeNull();
    const entries = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "job.check_in_undone"));
    expect(entries).toHaveLength(1);

    // And it can be checked in again for real.
    const again = await checkInAppointmentAction({ appointmentId });
    expect(again.ok).toBe(true);
  });

  it("restores arrived when the customer had been marked arrived first", async () => {
    const { appointmentId, jobId } = await checkedIn("arrived");
    expect((await undoCheckInAction({ jobId })).ok).toBe(true);
    const [appt] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appt.status).toBe("arrived");
  });

  it("clears the inspection and QC, and keeps photos on the vehicle", async () => {
    const { jobId } = await checkedIn();
    const inspectionId = newId("insp");
    await db().insert(schema.inspections).values({ id: inspectionId, jobId, mileage: 1000 });
    await db().insert(schema.inspectionFindings).values({
      id: newId("find"), inspectionId, area: "front_bumper", type: "scratch",
    });
    await db().insert(schema.qcChecklists).values({ id: newId("qc"), jobId, items: {} });
    const photoIds = [newId("file"), newId("file")];
    await db().insert(schema.files).values([
      { id: photoIds[0], entityType: "job", entityId: jobId, kind: "checkin", storageKey: "a", contentType: "image/jpeg", uploadedByType: "staff" },
      { id: photoIds[1], entityType: "inspection", entityId: inspectionId, kind: "damage", storageKey: "b", contentType: "image/jpeg", uploadedByType: "staff" },
    ]);

    expect((await undoCheckInAction({ jobId })).ok).toBe(true);

    expect(await db().select().from(schema.inspections)).toHaveLength(0);
    expect(await db().select().from(schema.inspectionFindings)).toHaveLength(0);
    expect(await db().select().from(schema.qcChecklists)).toHaveLength(0);
    const photos = await db().select().from(schema.files);
    expect(photos).toHaveLength(2);
    for (const photo of photos) {
      expect(photo.entityType).toBe("vehicle");
      expect(photo.entityId).toBe(vehicleId);
    }
  });

  it("refuses once work has started", async () => {
    const { jobId } = await checkedIn();
    expect((await transitionJobAction({ jobId, to: "in_progress" })).ok).toBe(true);
    const res = await undoCheckInAction({ jobId });
    expect(res.ok).toBe(false);
    expect(await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId))).toHaveLength(1);
  });

  it("refuses when extra work has been requested", async () => {
    const { jobId } = await checkedIn();
    await db().insert(schema.additionalWorkRequests).values({
      id: newId("awr"), jobId, description: "Pet hair", priceCents: 4000,
    });
    const res = await undoCheckInAction({ jobId });
    expect(res.ok).toBe(false);
    expect(await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId))).toHaveLength(1);
  });

  it("refuses when the job has an invoice", async () => {
    const { jobId } = await checkedIn();
    const invoiceId = newId("inv");
    await db().insert(schema.invoices).values({
      id: invoiceId, number: 9001, customerId, vehicleId, jobId, taxRateBp: 1300,
    } as never);
    const res = await undoCheckInAction({ jobId });
    expect(res.ok).toBe(false);
    expect(await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId))).toHaveLength(1);
  });
});
