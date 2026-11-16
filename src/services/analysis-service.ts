/**
 * Commands run in the sandbox, and the sources an agent keeps from a file
 * set (src/file-sets.ts).
 *
 * A command is one shell line an agent ran against the sets its run has.
 * Every command is recorded here as it is run (sandbox_calls): the command,
 * the files given with it, the sets it could read with their hashes, the
 * time, and the output stored whole with its SHA-256, whatever window of
 * it the agent was shown.
 *
 * A command is not a source. Agents explore: they list, search, try a
 * script and correct it. Sources are what assessments rest on, so the agent
 * says which commands those are: keepAnalysis turns one call into a source
 * row a judgment can cite, with enough in it that a reader with the same
 * clearance could run it again and compare.
 *
 * The two stamping rules (src/labels.ts), as they fall here:
 *
 *  - A call, and the analysis kept from it, carry the label of the run that
 *    ran the command (currentLabel). The command and any script are the
 *    run's own words, composed with whatever the run knows, and they are
 *    stored with what they produced. That label always reads the label of
 *    every set the command could read, or the run would not have been
 *    offered them.
 *  - A kept file is derived mechanically from the file and is the same
 *    whoever asks: the file's own text, under a heading made from the
 *    set's own facts. It carries the set's label, and the same file or
 *    passage kept twice, by any run, is one source. A row is added only by
 *    work at its own label (db/clearance.ts), so a run at another label
 *    that reads the set's keeps a file by a write made at the set's label.
 *    The source then shows the set's readers that some work rested on that
 *    file, or on those lines of it, and not whose work: no row of it names
 *    a run or a node.
 *
 * An analysis is kept by work at the label it was run at, like a reading
 * (services/reading-service.ts): the source is a row at that label.
 *
 * Whose material a source is follows the sets: a kept file belongs to its
 * set's party, and a kept analysis to the party whose sets the command
 * could read, where that is one party. Each party's stake is recorded on
 * the source (source_interests), as a fact about it and never a finding
 * against it.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { KEPT_FILE_MAX_CHARS, analysisAddress, keptFileAddress } from "../file-sets.js";
import { currentLabel, getUsageContext, runAtLabel } from "../llm/usage-context.js";
import { sanitizeStoredText, windowText, type TextWindow } from "./document-text.js";
import { fileSetDirectory, type RunFileSet } from "./file-set-service.js";
import { labelsReadableFrom } from "./permission-service.js";
import {
  runInSandbox,
  type SandboxEnded,
  type SandboxFailure,
  type SandboxHealth,
} from "./sandbox-client.js";
import { sourceContentHash } from "./source-content.js";
import { segmentSourceOnce } from "./source-segment-service.js";
import { meterExternalUsage } from "./usage-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who records the party's stake on a source kept from a file set: the set, mechanically, not an agent. */
export const FILE_SET_INTEREST_RECORDED_BY = "file_set";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fmt = (n: number): string => n.toLocaleString("en-US");

/** A set as a call records it: enough to say, later, exactly which files the command could read. */
export interface CalledSet {
  id: string;
  name: string;
  slug: string;
  party_id: string;
  party: string;
  stake: string;
  files: number;
  manifest_sha256: string;
  /** Where the set was mounted in the sandbox. */
  path: string;
}

export interface GivenFile {
  path: string;
  content: string;
  sha256: string;
}

export type CommandRun =
  | {
      ran: true;
      id: string;
      calledAt: string;
      ended: SandboxEnded;
      exitCode: number | null;
      signal: number | null;
      durationMs: number;
      output: string;
      outputSha256: string;
      written: Array<{ path: string; bytes: number; sha256: string }>;
      writtenNotListed: number;
      scratch: string;
      /** Where the command stood against each limit, for the line the agent is shown. */
      used: { outputBytes: number; memoryMbPeak: number; scratchBytes: number };
      memoryMbUsed: number | null;
      /** What the command's time was charged to the run's budget, in micro-USD; 0 where nothing is charged. */
      chargedMicroUsd: number;
    }
  | { ran: false; id: string; failure: SandboxFailure };

/** Where a set is in the sandbox's own filesystem. */
export function sandboxPathOf(set: Pick<RunFileSet, "origin" | "storageKey">, health: SandboxHealth): string | null {
  const root = set.origin === "upload" ? health.paths.store : health.paths.directoryRoot;
  return root ? `${root.replace(/\/+$/, "")}/${set.storageKey}` : null;
}

/** What `seconds` of a command's time costs a run, at the deployment's hourly rate. */
export function sandboxCostMicroUsd(seconds: number, hourCostMicroUsd: number): number {
  return Math.round((Math.max(0, seconds) / 3600) * hourCostMicroUsd);
}

/**
 * Run one command: record it, send it once, and store what came back whole.
 * Never throws for anything the sandbox or the network did; that comes back
 * as a command that did not run, with why.
 */
export async function runCommand(input: {
  scratchKey: string;
  command: string;
  files: Array<{ path: string; content: string }>;
  sets: RunFileSet[];
  health: SandboxHealth;
}): Promise<CommandRun> {
  const context = getUsageContext();
  const given: GivenFile[] = input.files.map((f) => ({ path: f.path, content: f.content, sha256: sha256(f.content) }));
  const called: CalledSet[] = input.sets.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    party_id: s.partyId,
    party: s.partyName,
    stake: s.stake,
    files: s.fileCount,
    manifest_sha256: s.manifestHash,
    path: sandboxPathOf(s, input.health) ?? "",
  }));
  const [row] = await rawQuery<{ id: string; called_at: Date }>(
    `INSERT INTO sandbox_calls (command, files, file_sets, run_id, agent, claim_id, sensitivity_label)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)
     RETURNING id, called_at`,
    [
      input.command,
      JSON.stringify(given),
      JSON.stringify(called),
      context.runId ?? null,
      context.agent ?? null,
      context.claimId ?? null,
      // The run's label, not the sets': the command is the run's words.
      currentLabel(),
    ]
  );
  const id = row!.id;

  const started = Date.now();
  const answered = await runInSandbox({
    run: input.scratchKey,
    command: input.command,
    files: input.files,
    sets: input.sets.map((s) => ({ name: s.slug, origin: s.origin, key: s.storageKey })),
    commandSeconds: input.health.limits.commandSeconds,
  });
  if (!answered.ok) {
    await rawQuery(`UPDATE sandbox_calls SET outcome = 'failed', error = $2, duration_ms = $3 WHERE id = $1`, [
      id,
      answered.failure.message,
      Date.now() - started,
    ]);
    return { ran: false, id, failure: answered.failure };
  }
  const result = answered.value;
  // Stored as Postgres will take it, and hashed as stored, so the hash is of
  // the text a reader will be shown.
  const output = sanitizeStoredText(result.output);
  const outputHash = sha256(output);
  await rawQuery(
    `UPDATE sandbox_calls
        SET outcome = $2, exit_code = $3, output = $4, output_hash = $5, output_chars = $6, duration_ms = $7,
            written = $8::jsonb, written_not_listed = $9, sandbox_version = $10, sandbox_image = $11, python = $12
      WHERE id = $1`,
    [
      id,
      result.ended,
      result.exitCode,
      output,
      outputHash,
      output.length,
      result.durationMs,
      JSON.stringify(result.written),
      result.writtenNotListed,
      result.version,
      result.image,
      result.python,
    ]
  );
  // The command's time, charged to the run like any spend the token meter
  // does not see (config.ts, sandboxHourCostMicroUsd).
  const charged = sandboxCostMicroUsd(result.durationMs / 1000, loadConfig().sandboxHourCostMicroUsd ?? 0);
  if (charged > 0) {
    await meterExternalUsage({
      provider: "sandbox",
      model: `minerval-sandbox/${result.version}`,
      units: result.durationMs,
      unitKind: "wall_ms",
      costMicroUsd: charged,
    });
  }
  return {
    ran: true,
    id,
    calledAt: new Date(row!.called_at).toISOString(),
    ended: result.ended,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    output,
    outputSha256: outputHash,
    written: result.written,
    writtenNotListed: result.writtenNotListed,
    scratch: result.scratch,
    used: {
      outputBytes: result.outputBytes,
      memoryMbPeak: Math.max(result.memoryMbPeak, result.memoryMbUsed ?? 0),
      scratchBytes: result.scratchBytes,
    },
    memoryMbUsed: result.memoryMbUsed ?? null,
    chargedMicroUsd: charged,
  };
}

/** A call or a file no run at this label may be told of, and one that does not exist, read the same. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

const noSuchCall = (id: string) =>
  new AnalysisError(`No command ${id} is known to this run. A command's id is the "call" field of its result.`);

/** A command the run may open and may not keep: it was run by work at another label that this run's label reads. */
const ranByOtherWork = (id: string) =>
  new AnalysisError(
    `Command ${id} was run by other work, and an analysis is kept by the work that ran it. ` +
      `To rest a judgment on what it shows, run the command again in this run and keep that analysis.`
  );

/** The labels the enclosing run or request reads: its own, and those its own reads. */
async function readableLabels(): Promise<Set<string>> {
  return new Set(await labelsReadableFrom([currentLabel()]));
}

export interface OpenedOutput extends TextWindow {
  call: string;
  ran_at: string;
  ended: string;
  output_sha256: string;
}

/**
 * A window of a command's stored output, with the paging the source reader
 * has (services/document-text.ts). It runs nothing: it reads what was
 * stored when the command ended, so two windows are always of the same
 * output.
 */
export async function openOutput(input: { callId: string; offset?: number; maxChars?: number }): Promise<OpenedOutput> {
  const id = input.callId.trim();
  if (!UUID_RE.test(id)) throw noSuchCall(id);
  const [row] = await rawQuery<{
    called_at: Date;
    outcome: string | null;
    error: string | null;
    output: string | null;
    output_hash: string | null;
    sensitivity_label: string;
  }>(`SELECT called_at, outcome, error, output, output_hash, sensitivity_label FROM sandbox_calls WHERE id = $1`, [id]);
  if (!row || !(await readableLabels()).has(row.sensitivity_label)) throw noSuchCall(id);
  if (row.output === null || row.output_hash === null) {
    throw new AnalysisError(
      row.outcome === "failed"
        ? `Command ${id} did not run (${row.error ?? "the sandbox gave no answer"}), so there is no output to open.`
        : `Command ${id} has no output yet: it is still running.`
    );
  }
  return {
    call: id,
    ran_at: new Date(row.called_at).toISOString(),
    ended: row.outcome ?? "",
    output_sha256: row.output_hash,
    ...windowText(row.output, input.offset, input.maxChars),
  };
}

/** How a command ended, as one line of a kept analysis and of a result's note. */
export function endedLine(
  ended: string,
  exitCode: number | null,
  limits?: { commandSeconds: number; outputBytes: number; memoryMb: number; scratchMb: number } | null
): string {
  switch (ended) {
    case "exited":
      return `exit code ${exitCode ?? 0}`;
    case "timed_out":
      return limits
        ? `stopped at the time limit of ${fmt(limits.commandSeconds)} seconds, before it finished`
        : "stopped at the time limit, before it finished";
    case "memory":
      return limits
        ? `stopped for using more than the ${fmt(limits.memoryMb)} MB of memory a command may use`
        : "stopped for using more memory than a command may use";
    case "output_ceiling":
      return limits
        ? `stopped when its output passed ${fmt(limits.outputBytes)} bytes; the output below is the part before that`
        : "stopped when its output passed the ceiling; the output below is the part before that";
    case "scratch_full":
      return limits
        ? `stopped when its scratch directory passed ${fmt(limits.scratchMb)} MB`
        : "stopped when its scratch directory passed its size limit";
    case "killed":
      return "ended by the system and not by the command itself, which is what happens when the sandbox's machine runs out of memory";
    default:
      return ended;
  }
}

/**
 * The text of the source an analysis becomes: what was run, on what, in
 * what, how it ended, and what it printed, so that the source's hash fixes
 * all of it and a reader with the same clearance can run it again and
 * compare. Plain lines, then the command, each given file and the output
 * exactly as stored.
 */
export function analysisDocument(input: {
  calledAt: Date;
  durationMs: number | null;
  sandboxVersion: string | null;
  sandboxImage: string | null;
  python: string | null;
  sets: CalledSet[];
  files: GivenFile[];
  ended: string;
  exitCode: number | null;
  written: Array<{ path: string; bytes: number; sha256: string }>;
  writtenNotListed: number;
  command: string;
  outputSha256: string;
  output: string;
}): string {
  const head = [
    "An analysis run in this deployment's sandbox, which has no network.",
    `Run: ${input.calledAt.toISOString()}` +
      (input.durationMs !== null ? `, for ${(input.durationMs / 1000).toFixed(1)} seconds` : ""),
    `Sandbox: version ${input.sandboxVersion ?? "not recorded"}, image ${input.sandboxImage ?? "not recorded"}, ` +
      `Python ${input.python ?? "not recorded"}`,
    input.sets.length > 0 ? "File sets the command could read, each fixed by the hash of its manifest:" : "The command could read no file set.",
    ...input.sets.map(
      (s) =>
        `- "${s.name}", files of ${s.party}: ${fmt(s.files)} ${s.files === 1 ? "file" : "files"}, ` +
        `manifest SHA-256 ${s.manifest_sha256}, at ${s.path}`
    ),
    ...(input.files.length > 0
      ? [
          "Files given with the command, written to the scratch directory before it ran:",
          ...input.files.map((f) => `- ${f.path} (SHA-256 ${f.sha256})`),
        ]
      : []),
    `How it ended: ${endedLine(input.ended, input.exitCode)}`,
    ...(input.written.length > 0
      ? [
          "Files the command wrote in its scratch directory (their contents are not kept):",
          ...input.written.map((w) => `- ${w.path} (${fmt(w.bytes)} bytes, SHA-256 ${w.sha256})`),
          ...(input.writtenNotListed > 0 ? [`- and ${fmt(input.writtenNotListed)} more, not listed`] : []),
        ]
      : []),
    `Output SHA-256: ${input.outputSha256}`,
  ];
  const parts = [head.join("\n"), `Command:\n${input.command}`];
  for (const file of input.files) parts.push(`File ${file.path}:\n${file.content}`);
  parts.push(`Output:\n${input.output}`);
  return parts.join("\n\n");
}

export interface KeptSource {
  source_id: string;
  /** What to cite the source by. */
  address: string;
  title: string;
  /** SHA-256 of the source's text. */
  content_sha256: string;
  /** True when it had been kept before, and this is the source made then. */
  already_kept: boolean;
}

/**
 * The one interest row a source kept from file sets carries: the party and
 * its stake where the sets are one party's, and each party with its stake
 * where they are several (a source's interest is read as its newest row).
 */
function interestOf(sets: ReadonlyArray<{ party: string; stake: string }>): { party: string; stake: string } | null {
  const seen = new Map<string, Set<string>>();
  for (const set of sets) {
    if (!seen.has(set.party)) seen.set(set.party, new Set());
    seen.get(set.party)!.add(set.stake);
  }
  if (seen.size === 0) return null;
  if (seen.size === 1) {
    const [[party, stakes]] = [...seen.entries()] as [[string, Set<string>]];
    return { party, stake: [...stakes].join(" ") };
  }
  return {
    party: [...seen.keys()].join("; "),
    stake: [...seen.entries()].map(([party, stakes]) => `${party}: ${[...stakes].join(" ")}`).join(" "),
  };
}

/**
 * Keep an analysis as a source: one row a judgment can cite, made from the
 * call as it was recorded. The same call kept twice is one source. The
 * source carries the call's label, which is the label of the run that ran
 * the command. It belongs to the party whose sets the command could read
 * when they are one party's, and to no single party when they are several;
 * either way each party's stake is recorded on it.
 *
 * Its facts are marked as checked, so the worker that looks sources up at
 * Crossref and the Wayback Machine leaves it alone: an analysis is not on
 * the web, and its address must not be sent out to ask.
 */
export async function keepAnalysis(callId: string): Promise<KeptSource & { call: string }> {
  const id = callId.trim();
  if (!UUID_RE.test(id)) throw noSuchCall(id);
  const readable = await readableLabels();
  const kept = await withTransaction(async (tx) => {
    const [row] = await tx.query<{
      command: string;
      files: GivenFile[];
      file_sets: CalledSet[];
      called_at: Date;
      duration_ms: number | null;
      outcome: string | null;
      exit_code: number | null;
      error: string | null;
      output: string | null;
      output_hash: string | null;
      written: Array<{ path: string; bytes: number; sha256: string }> | null;
      written_not_listed: number | null;
      sandbox_version: string | null;
      sandbox_image: string | null;
      python: string | null;
      source_id: string | null;
      sensitivity_label: string;
    }>(
      `SELECT command, files, file_sets, called_at, duration_ms, outcome, exit_code, error, output, output_hash,
              written, written_not_listed, sandbox_version, sandbox_image, python, source_id, sensitivity_label
         FROM sandbox_calls WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!row || !readable.has(row.sensitivity_label)) throw noSuchCall(id);
    if (!row.source_id && row.sensitivity_label !== currentLabel()) throw ranByOtherWork(id);
    if (row.source_id) {
      const [source] = await tx.query<{ id: string; url: string; title: string; content_hash: string }>(
        `SELECT id, url, title, content_hash FROM sources WHERE id = $1`,
        [row.source_id]
      );
      return {
        call: id,
        source_id: source!.id,
        address: source!.url,
        title: source!.title,
        content_sha256: source!.content_hash,
        already_kept: true,
      };
    }
    if (row.output === null || row.output_hash === null) {
      throw new AnalysisError(
        row.outcome === "failed"
          ? `Command ${id} did not run (${row.error ?? "the sandbox gave no answer"}), so there is nothing to keep. ` +
            `That the analysis could not be made can be said in what you record.`
          : `Command ${id} has no output yet: it is still running.`
      );
    }
    const calledAt = new Date(row.called_at);
    const text = analysisDocument({
      calledAt,
      durationMs: row.duration_ms,
      sandboxVersion: row.sandbox_version,
      sandboxImage: row.sandbox_image,
      python: row.python,
      sets: row.file_sets,
      files: row.files,
      ended: row.outcome ?? "",
      exitCode: row.exit_code,
      written: row.written ?? [],
      writtenNotListed: row.written_not_listed ?? 0,
      command: row.command,
      outputSha256: row.output_hash,
      output: row.output,
    });
    const when = `run ${calledAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const title =
      row.file_sets.length === 1
        ? `Analysis of ${row.file_sets[0]!.name}, ${when}`
        : row.file_sets.length > 1
          ? `Analysis of ${row.file_sets.length} file sets, ${when}`
          : `Analysis in the sandbox, ${when}`;
    const address = analysisAddress(id);
    const contentHash = sourceContentHash(text)!;
    const parties = [...new Set(row.file_sets.map((s) => s.party_id))];
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources
         (url, title, raw_content, content_hash, retrieved_at, page_url_hash, facts_checked_at,
          sensitivity_label, party_id)
       VALUES ($1, $2, $3, $4, $5, '', now(), $6, $7)
       RETURNING id`,
      [address, title, text, contentHash, calledAt, row.sensitivity_label, parties.length === 1 ? parties[0] : null]
    );
    const interest = interestOf(row.file_sets);
    if (interest) {
      await tx.query(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id, sensitivity_label)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [
          source!.id,
          interest.party,
          interest.stake,
          FILE_SET_INTEREST_RECORDED_BY,
          getUsageContext().runId ?? null,
          row.sensitivity_label,
        ]
      );
    }
    await tx.query(`UPDATE sandbox_calls SET source_id = $2, kept_at = now() WHERE id = $1`, [id, source!.id]);
    return { call: id, source_id: source!.id, address, title, content_sha256: contentHash, already_kept: false };
  });
  // The source's passages, so an instance recorded from it is anchored like
  // any other. Never fails the keep: the document is already stored.
  if (!kept.already_kept) await segmentSourceOnce(kept.source_id);
  return kept;
}

/** What one pass over a file found. */
interface FileRead {
  sha256: string;
  bytes: number;
  /** False when the bytes are not text: a NUL byte, or not valid UTF-8. */
  text: boolean;
  lines: number;
  /** The text asked for: the whole file, or the lines of the passage. Null when it passed the size a source may hold. */
  content: string | null;
}

/**
 * Read a file once: hash all of it, and collect either all of its text or
 * the lines `first` to `last` (counted from 1). The whole file is always
 * hashed, whatever part is kept, because the hash is what says the file is
 * still the one the set was closed on.
 */
async function readFileOnce(path: string, lines: { first: number; last: number } | null): Promise<FileRead> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let isText = true;
  let line = 1;
  let content: string | null = "";
  const take = (piece: string) => {
    // Split so that each line can be counted, keeping its line ending.
    let from = 0;
    while (from < piece.length) {
      const at = piece.indexOf("\n", from);
      const end = at === -1 ? piece.length : at + 1;
      if (content !== null && (!lines || (line >= lines.first && line <= lines.last))) {
        content += piece.slice(from, end);
        if (content.length > KEPT_FILE_MAX_CHARS) content = null;
      }
      if (at !== -1) line += 1;
      from = end;
    }
  };
  let sawAny = false;
  let endsWithNewline = false;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
    if (!isText) continue;
    if (buffer.includes(0)) {
      isText = false;
      continue;
    }
    try {
      const piece = decoder.decode(buffer, { stream: true });
      if (piece.length > 0) {
        sawAny = true;
        endsWithNewline = piece.endsWith("\n");
        take(piece);
      }
    } catch {
      isText = false;
    }
  }
  if (isText) {
    try {
      const rest = decoder.decode();
      if (rest.length > 0) {
        sawAny = true;
        endsWithNewline = rest.endsWith("\n");
        take(rest);
      }
    } catch {
      isText = false;
    }
  }
  // A last line with no line ending is still a line; a file that ends with
  // one has no empty line after it.
  const count = !sawAny ? 0 : endsWithNewline ? line - 1 : line;
  return { sha256: hash.digest("hex"), bytes, text: isText, lines: count, content: isText ? content : null };
}

/**
 * The text of the source a kept file becomes. Everything in it comes from
 * the set and the file, and nothing from who asked or when, so the same
 * file or passage is the same text for every run.
 */
export function fileDocument(input: {
  setName: string;
  partyName: string;
  path: string;
  fileSha256: string;
  bytes: number;
  manifestSha256: string;
  addedAt: Date;
  totalLines: number | null;
  lines: { first: number; last: number } | null;
  content: string | null;
}): string {
  const head = [
    `A file of the file set "${input.setName}", files of ${input.partyName}.`,
    `Path: ${input.path}`,
    `File SHA-256: ${input.fileSha256} (${fmt(input.bytes)} bytes), taken when the set was added and matched when this was kept`,
    `Set manifest SHA-256: ${input.manifestSha256}`,
    `Set closed: ${input.addedAt.toISOString()}`,
    input.content === null
      ? "The file is not text, so its bytes are not reproduced here. The hash above fixes them."
      : input.lines
        ? `Lines ${fmt(input.lines.first)} to ${fmt(input.lines.last)} of ${fmt(input.totalLines ?? 0)}, as they are in the file:`
        : `The whole file, ${fmt(input.totalLines ?? 0)} ${input.totalLines === 1 ? "line" : "lines"}, as it is:`,
  ];
  return input.content === null ? head.join("\n") : `${head.join("\n")}\n\n${input.content}`;
}

/**
 * Keep a file of a set, or a passage of one, as a source. The file is read
 * from the set and hashed again first: a file that no longer matches the
 * hash taken when the set was added is not kept, since the set's record
 * would then vouch for bytes it never saw.
 *
 * The source carries the set's label and party, with the party's stake
 * recorded on it. `sets` is what the calling run is offered, so a run can
 * keep only from a set its label reads.
 */
export async function keepFile(
  input: { set: string; path: string; firstLine?: number; lastLine?: number },
  sets: readonly RunFileSet[]
): Promise<KeptSource & { file_set: string; path: string; file_sha256: string; lines?: { first: number; last: number; of: number } }> {
  const wanted = input.set.trim();
  const set = sets.find((s) => s.slug === wanted || s.name === wanted);
  if (!set) {
    throw new AnalysisError(
      `This run has no file set named ${JSON.stringify(wanted)}. Name a set as your brief names it.`
    );
  }
  const path = input.path.trim().replace(/^\/+/, "");
  const [file] = await rawQuery<{ id: string; bytes: string | number; sha256: string }>(
    `SELECT id, bytes, sha256 FROM file_set_files WHERE file_set_id = $1 AND path = $2`,
    [set.id, path]
  );
  if (!file) {
    throw new AnalysisError(
      `"${set.name}" has no file at ${JSON.stringify(path)}. A file is named by its path inside the set, ` +
        `without the directory the set is mounted at.`
    );
  }

  let lines: { first: number; last: number } | null = null;
  if (input.firstLine !== undefined || input.lastLine !== undefined) {
    const first = Math.trunc(input.firstLine ?? 1);
    const last = Math.trunc(input.lastLine ?? first);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first < 1 || last < first) {
      throw new AnalysisError("first_line and last_line are line numbers counted from 1, with last_line not before first_line.");
    }
    lines = { first, last };
  }

  const directory = fileSetDirectory(set);
  let read: FileRead;
  try {
    if (!directory || !(await stat(join(directory, path))).isFile()) throw new Error("not a file");
    read = await readFileOnce(join(directory, path), lines);
  } catch {
    throw new AnalysisError(
      `${JSON.stringify(path)} of "${set.name}" could not be read from where the set is kept, so it was not kept. ` +
        `What you record can say that the file could not be read.`
    );
  }
  if (read.sha256 !== file.sha256) {
    throw new AnalysisError(
      `${JSON.stringify(path)} of "${set.name}" is no longer the file that was hashed when the set was added ` +
        `(SHA-256 then ${file.sha256}, now ${read.sha256}), so it was not kept. What you record can say so.`
    );
  }
  if (lines && !read.text) {
    throw new AnalysisError(`${JSON.stringify(path)} is not text, so it has no lines to keep a passage of. Keep the whole file: its name, size and hash are kept.`);
  }
  if (lines && lines.first > read.lines) {
    throw new AnalysisError(`${JSON.stringify(path)} has ${fmt(read.lines)} lines, so there is no line ${fmt(lines.first)}.`);
  }
  if (lines) lines = { first: lines.first, last: Math.min(lines.last, read.lines) };
  if (read.text && read.content === null) {
    throw new AnalysisError(
      (lines ? `That passage` : `${JSON.stringify(path)}`) +
        ` is more than ${fmt(KEPT_FILE_MAX_CHARS)} characters, the most one source holds. Keep a passage of it with ` +
        `first_line and last_line` +
        (lines ? `, of fewer lines.` : `; the file has ${fmt(read.lines)} lines.`)
    );
  }

  const content = read.text ? sanitizeStoredText(read.content ?? "") : null;
  const text = fileDocument({
    setName: set.name,
    partyName: set.partyName,
    path,
    fileSha256: file.sha256,
    bytes: read.bytes,
    manifestSha256: set.manifestHash,
    addedAt: set.closedAt,
    totalLines: read.text ? read.lines : null,
    lines,
    content,
  });
  const address = keptFileAddress(set.slug, path, lines);
  const title = `${set.name}: ${path}` + (lines ? `, lines ${lines.first} to ${lines.last}` : "");
  const contentHash = sourceContentHash(text)!;

  // Written at the set's label, whichever label the run works at: the source
  // is the set's own material, the same whoever keeps it.
  const atSetLabel = <T>(fn: () => Promise<T>): Promise<T> =>
    set.label === currentLabel() ? fn() : runAtLabel(set.label, `file set ${set.id}`, fn);
  const kept = await atSetLabel(() => withTransaction(async (tx) => {
    // One source per file or passage, whoever keeps it: the address is made
    // from the set and the path alone.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('minerval:kept-file:' || $1::text))`, [address]);
    const [existing] = await tx.query<{ id: string; title: string; content_hash: string }>(
      `SELECT id, title, content_hash FROM sources WHERE url = $1`,
      [address]
    );
    if (existing) {
      return { source_id: existing.id, address, title: existing.title, content_sha256: existing.content_hash, already_kept: true };
    }
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources
         (url, title, raw_content, content_hash, retrieved_at, page_url_hash, facts_checked_at,
          sensitivity_label, party_id)
       VALUES ($1, $2, $3, $4, $5, '', now(), $6, $7)
       RETURNING id`,
      // The set's label and party: the file is the same whoever asks.
      [address, title, text, contentHash, set.closedAt, set.label, set.partyId]
    );
    // Neither row names the run that kept the file: both are at the set's
    // label, and a run at a label that reads the set's may be the one keeping.
    await tx.query(
      `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id, sensitivity_label)
       VALUES ($1, NULL, $2, $3, $4, NULL, $5)`,
      [source!.id, set.partyName, set.stake, FILE_SET_INTEREST_RECORDED_BY, set.label]
    );
    await tx.query(
      `INSERT INTO file_set_keeps (file_set_id, file_id, first_line, last_line, source_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [set.id, file.id, lines?.first ?? null, lines?.last ?? null, source!.id, set.label]
    );
    return { source_id: source!.id, address, title, content_sha256: contentHash, already_kept: false };
  }));
  if (!kept.already_kept) await segmentSourceOnce(kept.source_id);
  return {
    ...kept,
    file_set: set.name,
    path,
    file_sha256: file.sha256,
    ...(lines ? { lines: { first: lines.first, last: lines.last, of: read.lines } } : {}),
  };
}
