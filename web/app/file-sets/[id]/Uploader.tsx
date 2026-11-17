"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "@/components/work/icons";
import { Pill, Tip } from "@/components/work/ui";

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
  const [over, setOver] = useState(false);

  async function run(files: File[]) {
    if (files.length === 0 || busy) return;
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

  const inProgress = rows.filter((r) => r.state === "waiting" || r.state === "hashing here" || r.state === "sending").length;
  const added = rows.filter((r) => r.state === "done").length;
  const refused = rows.filter((r) => r.state === "refused").length;

  return (
    <section className="w-sec">
      <div className="w-sec-h">
        <h2>Upload</h2>
        {rows.length > 0 && (
          <span className="w-muted">
            {[inProgress > 0 && `${inProgress} in progress`, added > 0 && `${added} added`, refused > 0 && `${refused} refused`].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <label
        className={over ? "w-fs-drop w-fs-over" : "w-fs-drop"}
        aria-disabled={busy}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void run([...e.dataTransfer.files]);
        }}
      >
        <Icon name="file" size={22} />
        <span>
          <b style={{ fontWeight: 500, color: "var(--w-ink)" }}>{busy ? "Uploading…" : "Drop files"}</b>{" "}
          <span className="w-muted">· each file is hashed in your browser and checked on arrival · files are never replaced</span>{" "}
          <Tip>
            Each file is sent as a stream and hashed by the deployment as it arrives. Files over 256 MB are hashed on arrival only. A path the set already has is refused: a file in a set is not replaced. Files are added under their own names.
          </Tip>
        </span>
        <span className="w-btn w-sm">Choose files</span>
        <input ref={input} type="file" multiple disabled={busy} onChange={() => void run([...(input.current?.files ?? [])])} />
      </label>
      {rows.length > 0 && (
        <div className="w-tbox" aria-live="polite">
          {rows.map((r) => {
            const pct = r.bytes === 0 ? 100 : Math.floor((r.sent / r.bytes) * 100);
            return (
              <div className="w-fs-prog" key={r.path}>
                <span className="w-mono w-fs-trunc" title={r.path}>
                  {r.path}
                </span>
                <span className="w-num w-muted">{size(r.bytes)}</span>
                {r.state === "sending" ? (
                  <span className="w-row" style={{ flexWrap: "nowrap" }}>
                    <span className="w-bar" style={{ flex: 1 }}>
                      <i className="w-fs-run" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="w-num w-faint w-small" style={{ width: 34 }}>
                      {pct}%
                    </span>
                  </span>
                ) : r.state === "done" ? (
                  <span className="w-mono w-faint w-fs-trunc" title={`SHA-256 taken by the deployment: ${r.sha256 ?? ""}`}>
                    {r.sha256?.slice(0, 16)}…
                  </span>
                ) : r.state === "refused" ? (
                  <span className="w-said w-error w-fs-trunc" title={r.error}>
                    {r.error}
                  </span>
                ) : (
                  <span className="w-muted w-small">{r.state === "hashing here" ? "Taking its hash here…" : "Waiting"}</span>
                )}
                <span>
                  {r.state === "sending" && <Pill tone="info">Sending</Pill>}
                  {r.state === "done" &&
                    (r.mine ? (
                      r.mine === r.sha256 ? (
                        <Pill tone="ok" title="The hash the deployment took is the one taken in your browser">
                          Hash matches
                        </Pill>
                      ) : (
                        <Pill tone="bad" title="What arrived is not what was sent: the deployment's hash is not the one taken in your browser">
                          Hash differs
                        </Pill>
                      )
                    ) : (
                      <Pill tone="ok" title="Too large to hash in the browser; hashed by the deployment on arrival">
                        In the set
                      </Pill>
                    ))}
                  {r.state === "refused" && (
                    <Pill tone="bad" title={r.error}>
                      Not added
                    </Pill>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
