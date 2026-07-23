import "server-only";

import { notFound, redirect } from "next/navigation";
import { getStaff, type StaffContext } from "./session";
import { roleHas, type Permission } from "./permissions";

/**
 * Read gate for admin Server Components. Unlike the action-oriented
 * `requireStaff`, this uses framework navigation signals for anonymous or
 * forbidden page requests, avoiding noisy AuthError rendering races while
 * the parent admin layout redirects.
 */
export async function requirePageStaff(...permissions: Permission[]): Promise<StaffContext> {
  const staff = await getStaff();
  if (!staff) redirect("/admin/login");
  for (const permission of permissions) {
    if (!roleHas(staff.role, permission)) notFound();
  }
  return staff;
}
