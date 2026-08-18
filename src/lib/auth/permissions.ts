import type { StaffRole } from "@/lib/types";

/**
 * Server-enforced permission map. UI may additionally hide controls, but every
 * server action / route handler must call requireStaff(...perms) — hiding
 * buttons is never the security boundary.
 */
export const PERMISSIONS = {
  manage_staff: ["owner"],
  /** Provider API credentials — owner only, matching manage_staff. */
  manage_integrations: ["owner"],
  manage_settings: ["owner", "manager"],
  manage_services: ["owner", "manager"],
  manage_bookings: ["owner", "manager", "reception"],
  manage_customers: ["owner", "manager", "reception"],
  anonymize_customers: ["owner", "manager"],
  manage_estimates: ["owner", "manager", "reception"],
  work_jobs: ["owner", "manager", "reception", "technician"],
  manage_invoices: ["owner", "manager", "accountant"],
  record_payments: ["owner", "manager", "reception", "accountant"],
  issue_refunds: ["owner", "manager"],
  view_financial_reports: ["owner", "manager", "accountant"],
  /** Recording what the business spends. Reception and technicians are
   * deliberately excluded — cost data is owner/manager/bookkeeper only. */
  manage_expenses: ["owner", "manager", "accountant"],
  /**
   * Logging hours worked. Narrower than manage_expenses on purpose: the week
   * grid shows what every staff member earned, which is pay data, but entering
   * hours is a shop-floor task the manager does daily. The accountant does not
   * need it — they read the payroll report — and a technician logging only
   * their own hours would need its own own-row-only gate, which is not built.
   */
  manage_timesheets: ["owner", "manager"],
  view_private_files: ["owner", "manager", "reception", "technician"],
  view_dashboard: ["owner", "manager", "reception", "technician", "accountant"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleHas(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}
