"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteExpenseReceiptAction, uploadExpenseReceiptsAction } from "./actions";
import {
  MAX_RECEIPTS_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  RECEIPT_ACCEPT,
  RECEIPT_TYPES,
  isReceiptImage,
  receiptUrl,
  type ExpenseReceipt,
} from "./receipts";

/**
 * Attaching the bill to the number.
 *
 * Two shapes for one job, because an expense being added does not have an id
 * yet: the picker STAGES files in the browser and the form uploads them once
 * the row exists, while the gallery on a saved row uploads on drop. Both go
 * through the same server action, and both mirror its limits client-side so a
 * 30 MB phone photo is refused before it is pushed over the wire.
 */

/** Browsers that cannot paint HEIC still show a readable chip for it. */
const PREVIEWABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The client half of the server's validation, worded the same way. */
export function checkReceiptFiles(files: File[], alreadyStaged = 0): string | null {
  if (files.length + alreadyStaged > MAX_RECEIPTS_PER_UPLOAD) {
    return `At most ${MAX_RECEIPTS_PER_UPLOAD} files at a time`;
  }
  for (const file of files) {
    if (!RECEIPT_TYPES[file.type]) return "Receipts must be a JPEG, PNG, WebP, HEIC or PDF";
    if (file.size > MAX_RECEIPT_BYTES) return "Each file must be under 10 MB";
  }
  return null;
}

/** Dashed drop target that also opens the file browser when clicked. */
function DropZone({
  onFiles,
  disabled,
  busy,
  label,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(false);
        onFiles(Array.from(event.dataTransfer.files));
      }}
      className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
        over ? "border-[#E0A93B] bg-[#FFF9E9]" : "border-[#CBD6E1] bg-[#F8FAFC]"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={RECEIPT_ACCEPT}
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          // Cleared so re-picking the same file still fires a change event.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="min-h-10 rounded-lg border border-[#B9C7D4] bg-white px-4 py-2 text-sm font-semibold text-[#0B2A4A] hover:border-[#8FA2B4] disabled:opacity-50"
      >
        {busy ? "Uploading…" : label}
      </button>
      <p className="mt-2 text-xs text-[#718296]">
        Or drop a photo of the receipt here. JPEG, PNG, WebP, HEIC or PDF, up to 10 MB each.
      </p>
    </div>
  );
}

/** One staged-or-saved tile. */
function ReceiptTile({
  href,
  contentType,
  caption,
  detail,
  onRemove,
  removing,
}: {
  href?: string;
  contentType: string;
  caption: string;
  detail: string;
  onRemove: () => void;
  removing?: boolean;
}) {
  const body = (
    <>
      {href && PREVIEWABLE.has(contentType) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={href} alt={caption} className="h-24 w-full rounded-lg object-cover" />
      ) : (
        <span className="flex h-24 w-full items-center justify-center rounded-lg bg-[#EEF2F6] text-xs font-semibold uppercase tracking-wide text-[#526A80]">
          {isReceiptImage(contentType) ? "Image" : "PDF"}
        </span>
      )}
      <span className="mt-1 block truncate text-[11px] text-[#6B7D90]">{detail}</span>
    </>
  );

  return (
    <div className="relative">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="block" title={caption}>
          {body}
        </a>
      ) : (
        <div title={caption}>{body}</div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${caption}`}
        className="absolute right-1 top-1 rounded-full bg-white/90 px-2 py-0.5 text-xs font-bold text-[#8A2020] shadow-sm hover:bg-white disabled:opacity-40"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Staging area for the "Add an expense" form. The files are held here until the
 * expense row exists; the form calls `uploadStagedReceipts` right after saving.
 */
export function ReceiptPicker({
  files,
  onChange,
}: {
  files: File[];
  onChange: (next: File[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // Object URLs are revoked together whenever the staged set changes, so a
  // long receipt-entry session does not leak a blob per photo.
  const previews = useMemo(
    () => files.map((file) => (PREVIEWABLE.has(file.type) ? URL.createObjectURL(file) : undefined)),
    [files],
  );
  useEffect(
    () => () => {
      for (const url of previews) if (url) URL.revokeObjectURL(url);
    },
    [previews],
  );

  const add = useCallback(
    (incoming: File[]) => {
      const usable = incoming.filter((file) => file.size > 0);
      if (usable.length === 0) return;
      const problem = checkReceiptFiles(usable, files.length);
      if (problem) return setError(problem);
      setError(null);
      onChange([...files, ...usable]);
    },
    [files, onChange],
  );

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-[#526A80]">Receipt or bill (optional)</p>
      {files.length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {files.map((file, index) => (
            <ReceiptTile
              key={`${file.name}-${index}`}
              href={previews[index]}
              contentType={file.type}
              caption={file.name}
              detail={`${file.name} · ${formatBytes(file.size)}`}
              onRemove={() => onChange(files.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}
      <div className="mt-2">
        <DropZone onFiles={add} label={files.length > 0 ? "Add another file" : "Choose a file"} />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {files.length > 0 && (
        <p className="mt-2 text-xs text-[#718296]">
          {files.length} {files.length === 1 ? "file attaches" : "files attach"} when you save the expense.
        </p>
      )}
    </div>
  );
}

/**
 * Uploads files staged by ReceiptPicker onto a freshly created expense.
 * Returns an error string rather than throwing: the expense itself already
 * saved, so a failed attachment is a message, never a rollback.
 */
export async function uploadStagedReceipts(expenseId: string, files: File[]): Promise<string | null> {
  if (files.length === 0) return null;
  const formData = new FormData();
  formData.set("expenseId", expenseId);
  for (const file of files) formData.append("receipts", file);
  const result = await uploadExpenseReceiptsAction(formData);
  return result.ok ? null : result.error;
}

/** Receipts on an expense that already exists: uploads land immediately. */
export function ExpenseReceipts({
  expenseId,
  receipts,
}: {
  expenseId: string;
  receipts: ExpenseReceipt[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(receipts);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setItems(receipts), [receipts]);

  async function upload(incoming: File[]) {
    const usable = incoming.filter((file) => file.size > 0);
    if (usable.length === 0) return;
    const problem = checkReceiptFiles(usable);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set("expenseId", expenseId);
    for (const file of usable) formData.append("receipts", file);
    const result = await uploadExpenseReceiptsAction(formData);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setItems((current) => [...current, ...result.receipts]);
    router.refresh();
  }

  async function remove(fileId: string) {
    setRemovingId(fileId);
    setError(null);
    const result = await deleteExpenseReceiptAction({ fileId });
    setRemovingId(null);
    if (!result.ok) return setError(result.error);
    setItems((current) => current.filter((item) => item.id !== fileId));
    router.refresh();
  }

  return (
    <div>
      <p className="text-xs font-semibold text-[#526A80]">
        Receipts {items.length > 0 ? `(${items.length})` : ""}
      </p>
      {items.length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {items.map((item) => (
            <ReceiptTile
              key={item.id}
              href={receiptUrl(item.id)}
              contentType={item.contentType}
              caption="receipt"
              detail={formatBytes(item.sizeBytes)}
              onRemove={() => void remove(item.id)}
              removing={removingId === item.id}
            />
          ))}
        </div>
      )}
      <div className="mt-2">
        <DropZone
          onFiles={(files) => void upload(files)}
          busy={busy}
          label={items.length > 0 ? "Add another receipt" : "Attach a receipt"}
        />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
