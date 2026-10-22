import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_vehicle_edit_owner",
  name: "Test Owner",
  email: "vehicle-edit@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { updateCustomerVehicleAction } from "../src/app/admin/(app)/customers/actions";

let customerId: string;
let vehicleId: string;

const original = {
  year: 2019,
  make: "Ford",
  model: "Transit",
  trim: "250",
  category: "van",
  colour: "White",
  licencePlate: "BXRT 120",
  conditionNotes: "Scuff on rear bumper",
};

async function loadVehicle() {
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, vehicleId));
  return vehicle;
}

async function updateAudits() {
  return db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "customer.vehicle_updated"));
}

beforeEach(async () => {
  await db().execute(sql`TRUNCATE vehicles, customers, audit_log CASCADE`);
  customerId = newId("cus");
  vehicleId = newId("veh");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Fran", lastName: "Fleet", phone: "9055550100", preferredContact: "phone",
    customerType: "business", companyName: "Acme Couriers",
  });
  await db().insert(schema.vehicles).values({ id: vehicleId, customerId, ...original });
});

afterAll(async () => {
  await getPool().end();
});

describe("updateCustomerVehicleAction", () => {
  it("corrects the vehicle and audits only what changed", async () => {
    const res = await updateCustomerVehicleAction({
      customerId, vehicleId, ...original, model: "Transit Connect", category: "suv_small", licencePlate: "BXRT 121",
    });
    expect(res).toEqual({ ok: true });

    const vehicle = await loadVehicle();
    expect(vehicle.model).toBe("Transit Connect");
    expect(vehicle.category).toBe("suv_small");
    expect(vehicle.licencePlate).toBe("BXRT 121");
    expect(vehicle.make).toBe("Ford");

    const [entry] = await updateAudits();
    expect(entry.before).toEqual({ model: "Transit", category: "van", licencePlate: "BXRT 120" });
    expect(entry.after).toEqual({ customerId, model: "Transit Connect", category: "suv_small", licencePlate: "BXRT 121" });
  });

  it("clears optional fields that were emptied", async () => {
    const res = await updateCustomerVehicleAction({
      customerId, vehicleId, ...original, year: null, trim: "", colour: "", licencePlate: "  ", conditionNotes: "",
    });
    expect(res.ok).toBe(true);
    const vehicle = await loadVehicle();
    expect(vehicle.year).toBeNull();
    expect(vehicle.trim).toBeNull();
    expect(vehicle.colour).toBeNull();
    expect(vehicle.licencePlate).toBeNull();
    expect(vehicle.conditionNotes).toBeNull();
  });

  it("writes nothing when nothing changed", async () => {
    const res = await updateCustomerVehicleAction({ customerId, vehicleId, ...original });
    expect(res.ok).toBe(true);
    expect(await updateAudits()).toHaveLength(0);
  });

  it("requires a make and model", async () => {
    const res = await updateCustomerVehicleAction({ customerId, vehicleId, ...original, make: " " });
    expect(res.ok).toBe(false);
    expect((await loadVehicle()).make).toBe("Ford");
  });

  it("refuses a vehicle that belongs to another customer", async () => {
    const other = newId("cus");
    await db().insert(schema.customers).values({
      id: other, firstName: "Other", lastName: "Person", phone: "9055550101", preferredContact: "phone",
    });
    const res = await updateCustomerVehicleAction({ customerId: other, vehicleId, ...original, make: "Chevrolet" });
    expect(res).toEqual({ ok: false, error: "Vehicle not found on this account" });
    expect((await loadVehicle()).make).toBe("Ford");
  });
});
