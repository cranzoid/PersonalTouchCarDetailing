const CONNECT_ACTIONS = new Set([
  "book",
  "services",
  "gallery",
  "reviews",
  "quote",
  "call",
  "directions",
  "contact",
  "website",
]);

export async function POST(
  _request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;

  if (!CONNECT_ACTIONS.has(action)) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Azure Application Insights captures this event from server logs. Only the
  // button identifier is recorded; the endpoint does not set cookies or store
  // form, customer, or vehicle data.
  console.info(JSON.stringify({ event: "connect_link_click", action }));

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
