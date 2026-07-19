import type { StaffRole } from "@/lib/types";

/**
 * Server-enforced permission map. UI may additionally hide controls, but every
 * server action / route handler must call requireStaff(...perms) — hiding
 * buttons is never the security boundary.
 */
export const PERMISSIONS = {
  manage_staff: ["owner"],
  manage_settings: ["owner", "manager"],
  manage_services: ["owner", "manager"],
  manage_bookings: ["owner", "manager", "reception"],
  manage_customers: ["owner", "manager", "reception"],
  manage_estimates: ["owner", "manager", "reception"],
  work_jobs: ["owner", "manager", "reception", "technician"],
  manage_invoices: ["owner", "manager", "accountant"],
  record_payments: ["owner", "manager", "reception", "accountant"],
  issue_refunds: ["owner", "manager"],
  view_financial_reports: ["owner", "manager", "accountant"],
  view_dashboard: ["owner", "manager", "reception", "technician", "accountant"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleHas(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}
