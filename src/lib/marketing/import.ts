/**
 * Parses contacts pasted straight out of a spreadsheet, a notes app, or typed
 * one per line from a stack of business cards.
 *
 * Written to be forgiving about shape and strict about content: the owner
 * should not have to reformat fifty rows, but a row that would produce a
 * message addressed to nobody must be rejected loudly rather than sent.
 */

export type ParsedContact = {
  line: number;
  firstName: string;
  lastName: string;
  companyName: string;
  phone: string;
  email: string;
};

export type ParsedContactError = { line: number; text: string; problem: string };

export type ContactPasteResult = {
  contacts: ParsedContact[];
  errors: ParsedContactError[];
};

type ColumnKey = "firstName" | "lastName" | "companyName" | "phone" | "email";

const HEADER_ALIASES: Record<string, ColumnKey> = {
  "first name": "firstName",
  firstname: "firstName",
  first: "firstName",
  name: "firstName",
  contact: "firstName",
  "contact name": "firstName",
  "last name": "lastName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  company: "companyName",
  "company name": "companyName",
  business: "companyName",
  organisation: "companyName",
  organization: "companyName",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  cell: "phone",
  number: "phone",
  email: "email",
  "email address": "email",
  "e-mail": "email",
};

/** Order assumed when the paste has no header row. */
const DEFAULT_COLUMNS: ColumnKey[] = ["firstName", "companyName", "phone", "email"];

function splitRow(line: string): string[] {
  // Tabs win when present — that is what a spreadsheet paste produces, and a
  // company name like "Smith, Sons & Co" would otherwise split on its comma.
  const cells = line.includes("\t") ? line.split("\t") : line.split(",");
  return cells.map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim());
}

function detectHeader(cells: string[]): ColumnKey[] | null {
  const mapped = cells.map((cell) => HEADER_ALIASES[cell.toLowerCase().trim()]);
  // Two recognised headers is enough to trust the row; one could be a person
  // actually called "Name" or a company called "Phone".
  return mapped.filter(Boolean).length >= 2 ? mapped.map((key) => key ?? "companyName") : null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function parseContactPaste(raw: string): ContactPasteResult {
  const lines = raw.split(/\r?\n/);
  const contacts: ParsedContact[] = [];
  const errors: ParsedContactError[] = [];

  let columns = DEFAULT_COLUMNS;
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    const detected = detectHeader(splitRow(lines[i]));
    if (detected) {
      columns = detected;
      startIndex = i + 1;
    }
    break;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const cells = splitRow(line);
    const contact: ParsedContact = {
      line: i + 1,
      firstName: "",
      lastName: "",
      companyName: "",
      phone: "",
      email: "",
    };

    cells.forEach((cell, index) => {
      const key = columns[index];
      if (!key || cell.length === 0) return;
      contact[key] = contact[key].length > 0 ? `${contact[key]} ${cell}` : cell;
    });

    // Drop values that landed in the wrong column before trying to rescue
    // them, or a company name sitting in the phone column would block the scan
    // below from finding the real number.
    if (contact.email && !EMAIL_PATTERN.test(contact.email)) contact.email = "";
    if (contact.phone && !looksLikePhone(contact.phone)) contact.phone = "";

    // Rescue rows whose columns are in an order we did not expect: an address
    // is unmistakable, and a phone number nearly so.
    for (const cell of cells) {
      if (!contact.email && EMAIL_PATTERN.test(cell)) contact.email = cell;
      if (!contact.phone && looksLikePhone(cell) && !EMAIL_PATTERN.test(cell)) contact.phone = cell;
    }

    // A contact detail that was read as the company name is not a company name.
    if (contact.companyName === contact.email || contact.companyName === contact.phone) {
      contact.companyName = "";
    }
    if (contact.firstName === contact.email || contact.firstName === contact.phone) {
      contact.firstName = "";
    }

    if (!contact.phone && !contact.email) {
      errors.push({ line: i + 1, text: line.trim(), problem: "No usable phone number or email address" });
      continue;
    }
    if (!contact.firstName && !contact.companyName) {
      errors.push({ line: i + 1, text: line.trim(), problem: "No name or company" });
      continue;
    }

    // A single "name" cell holding "Dave Mitchell" should not put "Mitchell"
    // into a {{FirstName}} greeting.
    if (!contact.lastName && contact.firstName.includes(" ")) {
      const [first, ...rest] = contact.firstName.split(/\s+/);
      contact.firstName = first;
      contact.lastName = rest.join(" ");
    }

    contacts.push(contact);
  }

  return { contacts, errors };
}
