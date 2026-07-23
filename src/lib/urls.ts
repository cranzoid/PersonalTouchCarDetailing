/** Canonical public origin for links sent outside the application. */
export function getAppBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_BASE_URL must be configured in production");
    }
    return "http://localhost:3000";
  }
  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTPS in production");
  }
  return url.origin;
}

