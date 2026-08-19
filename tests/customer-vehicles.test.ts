import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_vehicle_test_owner",
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
import { newId } from "../src/lib/id";
import {
  addCustomerVehicleAction,
  removeCustomerVehicleAction,
} from "../src/app/admin/(app)/customers/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE files, invoice_line_items, invoices, jobs, estimate_line_items, estimates,
             quote_requests, appointment_services, appointments, vehicles, customers,
             audit_log CASCADE
  `);
  auth.requireStaff.mockClear();
  auth.requireStaff.mockResolvedValue(auth.actor);
}

async function insertCustomer(name = "Vehicle Customer") {
  const id = newId("cus");
  await db().insert(schema.customers).values({
    id,
    firstName: name,
    lastName: "",
    phone: "9055550100",
    preferredContact: "phone",
  });
  return id;
}

describe("customer vehicle removal", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("removes an unused vehicle and audits its identifying details", async () => {
    const customerId = await insertCustomer();
    const added = await addCustomerVehicleAction({
      customerId,
      year: 2024,
      make: "Honda",
      model: "Civic",
      category: "sedan",
      colour: "Blue",
      licencePlate: "WRONG1",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("Vehicle setup failed");

    expect(await removeCustomerVehicleAction({
      customerId,
      vehicleId: added.vehicleId,
      confirmation: "REMOVE",
    })).toEqual({ ok: true });
    expect(await db().select().from(schema.vehicles)).toHaveLength(0);

    const [entry] = await db().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, "customer.vehicle_removed"));
    expect(entry.entityId).toBe(added.vehicleId);
    expect(entry.before).toMatchObject({ customerId, make: "Honda", model: "Civic", licencePlate: "WRONG1" });
  });

  it("does not allow one customer account to remove another customer's vehicle", async () => {
    const customerId = await insertCustomer("First Customer");
    const otherCustomerId = await insertCustomer("Other Customer");
    const vehicleId = newId("veh");
    await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Ford", model: "Escape", category: "suv_small" });

    expect(await removeCustomerVehicleAction({ customerId: otherCustomerId, vehicleId, confirmation: "REMOVE" }))
      .toEqual({ ok: false, error: "Vehicle not found on this account" });
    expect(await db().select().from(schema.vehicles)).toHaveLength(1);
  });

  it("protects a vehicle once an appointment references it", async () => {
    const customerId = await insertCustomer();
    const vehicleId = newId("veh");
    await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Toyota", model: "RAV4", category: "suv_small" });
    await db().insert(schema.appointments).values({
      id: newId("apt"),
      customerId,
      vehicleId,
      startsAt: new Date("2026-08-20T14:00:00Z"),
      endsAt: new Date("2026-08-20T16:00:00Z"),
      durationMin: 120,
    });

    expect(await removeCustomerVehicleAction({ customerId, vehicleId, confirmation: "REMOVE" }))
      .toEqual({
        ok: false,
        error: "This vehicle cannot be removed because it is used by an appointment. Historical records must be preserved.",
      });
    expect(await db().select().from(schema.vehicles)).toHaveLength(1);
  });
});
