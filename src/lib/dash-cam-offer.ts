/**
 * The dash cam installation page, for paid traffic.
 *
 * Dash cams are not in the catalogue and cannot be booked online: the shop
 * prices and installs them by phone. So the page collects a callback request
 * through the public quote action, and the only dash cam facts it states are
 * the ones the owner already publishes on /winter: from $99, installation
 * included, professionally installed. No camera models or features are named,
 * because none have been supplied.
 */
export const DASH_CAM_PAGE_PATH = "/dash-cams";

/** "From" price. Shared with the Dash Cams card on /winter so they cannot drift apart. */
export const DASH_CAM_FROM_CENTS = 9_900;

/** Stamped into `attribution.enquiryType`, so the lead is told apart from a general quote. */
export const DASH_CAM_ENQUIRY_TYPE = "dash_cam";

/** What the owner has said about the product. Nothing else goes on the page. */
export const DASH_CAM_POINTS = [
  "Free installation included",
  "Professionally installed",
  "Helps record drives and unexpected road incidents",
] as const;
