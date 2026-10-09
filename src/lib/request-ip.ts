import { headers } from "next/headers";

/**
 * The visitor's IP address, which Helcim requires on every payment request for
 * its fraud checks. Behind Azure's front end the client is the first entry of
 * X-Forwarded-For. Outside a request (cron, tests) there is no visitor, so the
 * loopback address stands in — those are merchant-initiated charges with no
 * customer browser behind them.
 */
export async function requestIp(): Promise<string> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    const candidate = forwarded || h.get("x-real-ip")?.trim() || "";
    // Azure appends the port ("203.0.113.7:51234"); Helcim wants a bare address.
    const bare = candidate.replace(/^\[?([^\]]+?)\]?(?::\d+)?$/, "$1");
    return /^[0-9a-f.:]+$/i.test(bare) && bare.length >= 3 ? bare : "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}
