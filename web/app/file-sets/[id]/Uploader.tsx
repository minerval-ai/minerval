"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// Upload into an open file set, one file at a time
// (PUT /api/file-sets/:id/files/<path>, which hands the bytes to the API as
// a stream). Each file shows how far it has got: how much has been sent,
// then the size and SHA-256 the deployment took as the bytes arrived. For a
// file small enough to read whole in the browser, the same hash is taken
// here first and the two are compared, so the person can see that what the
// deployment hashed is what they sent.

interface Row {
  path: string;
  bytes: number;
  state: "waiting" | "hashing here" | "sending" | "done" | "refused";
  sent: number;
  sha256?: string;
  mine?: string;
  error?: string;
}

/** Above this size the browser does not take its own hash: it would have to hold the whole file in memory to do it. */
const HASH_HERE_MAX_BYTES = 256 * 1024 * 1024;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function send(setId: string, path: string, file: File, onProgress: (sent: number) => void): Promise<{ ok: boolean; sha256?: string; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/file-sets/${setId}/files/${path.split("/").map(encodeURIComponent).join("/")}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: { file?: { sha256?: string }; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: say what the status was
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, sha256: body.file?.sha256 });
      else resolve({ ok: false, error: body.error ?? `The upload was refused (${xhr.status}).` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "The upload did not reach the deployment." });
    xhr.send(file);
  });
}

export function Uploader({ setId }: { setId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  async function run() {
    const files = [...(input.current?.files ?? [])];
    if (files.length === 0) return;
    setBusy(true);
    const list: Row[] = files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes: f.size, state: "waiting", sent: 0 }));
    setRows(list);
    const update = (i: number, change: Partial<Row>) => {
      list[i] = { ...list[i]!, ...change };
      setRows([...list]);
    };
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      let mine: string | undefined;
      if (file.size <= HASH_HERE_MAX_BYTES && crypto?.subtle) {
        update(i, { state: "hashing here" });
        mine = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      }
      update(i, { state: "sending", mine });
      const result = await send(setId, list[i]!.path, file, (sent) => update(i, { sent }));
      update(i, result.ok ? { state: "done", sent: file.size, sha256: result.sha256 } : { state: "refused", error: result.error });
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="uploader">
      <label>
        Files to add
        <input ref={input} type="file" multiple disabled={busy} />
        <small>
          Each file is sent to the deployment as a stream and hashed there as it arrives. A path the set already has is refused: a file in
          a set is not replaced. Files are added under their own names.
        </small>
      </label>
      <button type="button" className="order-button" onClick={run} disabled={busy}>
        {busy ? "Uploading…" : "Upload these files"}
      </button>
      {rows.length > 0 && (
        <ul className="uploader-rows" aria-live="polite">
          {rows.map((r) => (
            <li key={r.path}>
              <code>{r.path}</code> · {size(r.bytes)} ·{" "}
              {r.state === "waiting" && "waiting"}
              {r.state === "hashing here" && "taking its hash in your browser…"}
              {r.state === "sending" && `sending, and being hashed by the deployment as it arrives: ${r.bytes === 0 ? 100 : Math.floor((r.sent / r.bytes) * 100)}%`}
              {r.state === "done" && (
                <>
                  in the set. SHA-256 taken by the deployment: <code title={r.sha256}>{r.sha256?.slice(0, 16)}</code>
                  {r.mine ? (r.mine === r.sha256 ? ", the same as the one taken in your browser" : ", which is NOT the one taken in your browser: what arrived is not what was sent") : ""}.
                </>
              )}
              {r.state === "refused" && <span className="admin-form-error">not added. {r.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
