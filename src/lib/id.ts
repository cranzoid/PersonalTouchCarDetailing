import { randomBytes } from "crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // crockford-ish, no ambiguous chars

function randomId(len = 20): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

export type IdPrefix =
  | "usr" // staff user
  | "ses" // staff session
  | "tok" // customer access token record
  | "aud" // audit log entry
  | "cus" // customer
  | "veh" // vehicle
  | "lead"
  | "cat" // service category
  | "svc" // service
  | "adj" // vehicle adjustment
  | "add" // addon
  | "res" // resource / bay
  | "blk" // schedule block
  | "apt" // appointment
  | "aps" // appointment service line
  | "qr" // quote request
  | "est" // estimate
  | "eli" // estimate line item
  | "job"
  | "insp"
  | "find" // inspection finding
  | "file"
  | "awr" // additional work request
  | "qc"
  | "inv" // invoice
  | "ili" // invoice line item
  | "pay"
  | "whe" // webhook event
  | "com" // communication
  | "tpl" // message template
  | "sch"; // staff schedule row

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomId()}`;
}
