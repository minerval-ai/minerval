// The browser's prize forms against the API's contracts (src/routes/prizes.ts,
// docs/mathematics.md §8.4, §8.7): the multipart field names the filing and
// the tax-form upload read, the JSON body the payee step reads, and the plain
// sentences the API's refusal codes turn into. Pure functions over FormData
// and plain objects, with no server-only import, so the mappings are pinned
// by unit tests without a request. The API validates everything again.

export const PRIZE_CLAIM_CONTENT_MIN = 200;
export const PRIZE_CLAIM_CONTENT_MAX = 20_000;
export const PRIZE_CLAIM_LINKS_MAX = 10;
export const LEAN_MAX_BYTES = 256 * 1024;
export const DOCS_MAX = 5;
export const DOC_MAX_BYTES = 10 * 1024 * 1024;
export const DOCS_TOTAL_BYTES = 25 * 1024 * 1024;
export const TAX_FORM_MAX_BYTES = 10 * 1024 * 1024;

export type FormResult = { ok: true; form: FormData } | { ok: false; error: string };

type Upload = Blob & { name?: string };

// A non-empty uploaded file. Checked structurally (a Blob with a name), so it
// holds for the browser's File, the Next runtime's, and Node's alike.
function uploadOf(value: FormDataEntryValue | null): Upload | null {
  if (!value || typeof value === "string") return null;
  const blob = value as Upload;
  return blob.size > 0 ? blob : null;
}

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function affirmed(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "yes" || value === "1";
}

function yesNo(value: FormDataEntryValue | null): boolean | null {
  if (value === "yes" || value === "true") return true;
  if (value === "no" || value === "false") return false;
  return null;
}

export function isCountryCode(value: string): boolean {
  return /^[A-Za-z]{2}$/.test(value);
}

/**
 * The filing (POST /claims/:id/prize-claims). The browser's form names its
 * fields for the person filling it; the API reads:
 *
 *   formalization_id, direction, content, links (a JSON array),
 *   lean_source (the file part) or lean_source_text (pasted source),
 *   documents (file parts), tools_disclosure, residency_country (alpha-2),
 *   us_person ("true" | "false"), credit_name,
 *   declarations (JSON: eligibility, understanding, cc0, rules as booleans),
 *   rules_version.
 *
 * Nothing else is forwarded: the form's presentational fields (lean_mode,
 * statement_version) stay here.
 */
export function buildPrizeClaimApiForm(input: FormData): FormResult {
  const out = new FormData();

  const formalizationId = text(input, "formalization_id");
  if (!formalizationId) return { ok: false, error: "The statement version is missing; reload the page." };
  out.set("formalization_id", formalizationId);

  const direction = text(input, "direction");
  if (direction !== "proof" && direction !== "disproof") {
    return { ok: false, error: "Say whether this is a proof or a disproof." };
  }
  out.set("direction", direction);

  const content = text(input, "content");
  if (content.length < PRIZE_CLAIM_CONTENT_MIN || content.length > PRIZE_CLAIM_CONTENT_MAX) {
    return {
      ok: false,
      error: `The written account must run between ${PRIZE_CLAIM_CONTENT_MIN} and ${PRIZE_CLAIM_CONTENT_MAX.toLocaleString("en-US")} characters.`,
    };
  }
  out.set("content", content);

  const links = text(input, "links").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (links.length > PRIZE_CLAIM_LINKS_MAX) return { ok: false, error: `At most ${PRIZE_CLAIM_LINKS_MAX} links.` };
  for (const u of links) {
    if (!/^https?:\/\/\S+$/i.test(u)) return { ok: false, error: `Links must be full web addresses; "${u}" is not.` };
  }
  out.set("links", JSON.stringify(links));

  const leanFile = uploadOf(input.get("lean_file")) ?? uploadOf(input.get("lean_source"));
  const leanText = typeof input.get("lean_source") === "string" ? String(input.get("lean_source")) : "";
  if (leanFile) {
    if (leanFile.size > LEAN_MAX_BYTES) return { ok: false, error: "The Lean file must be at most 256 KiB." };
    out.set("lean_source", leanFile, leanFile.name || "proof.lean");
  } else if (leanText.trim()) {
    if (new TextEncoder().encode(leanText).length > LEAN_MAX_BYTES) {
      return { ok: false, error: "The Lean source must be at most 256 KiB." };
    }
    out.set("lean_source_text", leanText);
  } else {
    return { ok: false, error: "Attach the Lean file or paste the Lean source." };
  }

  const docs = input.getAll("documents").map(uploadOf).filter((d): d is Upload => d !== null);
  if (docs.length > DOCS_MAX || docs.some((d) => d.size > DOC_MAX_BYTES)
    || docs.reduce((s, d) => s + d.size, 0) > DOCS_TOTAL_BYTES) {
    return { ok: false, error: "At most five documents, 10 MiB each and 25 MiB in all." };
  }
  docs.forEach((d, i) => out.append("documents", d, d.name || `document-${i + 1}`));

  const tools = text(input, "tools_disclosure");
  if (!tools) return { ok: false, error: "Say which tools were used, or that none were." };
  out.set("tools_disclosure", tools);

  const country = text(input, "residency_country").toUpperCase();
  if (!isCountryCode(country)) {
    return { ok: false, error: "Give your country of residence as its two-letter code, such as GB or DE." };
  }
  out.set("residency_country", country);

  const usPerson = yesNo(input.get("us_person"));
  if (usPerson === null) return { ok: false, error: "Say whether you are a U.S. person." };
  out.set("us_person", usPerson ? "true" : "false");

  const creditName = text(input, "credit_name");
  if (!creditName) return { ok: false, error: "Choose a credit name for the record." };
  out.set("credit_name", creditName);

  const declarations = {
    eligibility: affirmed(input.get("declare_eligible")),
    understanding: affirmed(input.get("declare_understands")),
    cc0: affirmed(input.get("declare_cc0")),
    rules: affirmed(input.get("declare_rules")),
  };
  if (!Object.values(declarations).every(Boolean)) return { ok: false, error: "Each declaration must be made." };
  out.set("declarations", JSON.stringify(declarations));

  const rulesVersion = text(input, "rules_version");
  if (!rulesVersion) return { ok: false, error: "The rules version is missing; reload the page." };
  out.set("rules_version", rulesVersion);

  return { ok: true, form: out };
}

/**
 * The tax form (POST /prize-claims/:id/attachments). The API reads the
 * file part `tax_form`, `kind` as w9 | w8ben, and the one-time `code`
 * issued for the payee step.
 */
export function buildTaxFormApiForm(input: FormData): FormResult {
  const file = uploadOf(input.get("tax_form")) ?? uploadOf(input.get("file"));
  if (!file) return { ok: false, error: "Attach the completed form." };
  if (file.size > TAX_FORM_MAX_BYTES) return { ok: false, error: "The form must be at most 10 MiB." };
  const kind = text(input, "kind") || text(input, "form_kind");
  if (kind !== "w9" && kind !== "w8ben") return { ok: false, error: "Say whether the form is a W-9 or a W-8BEN." };
  const code = text(input, "code");
  if (!code) return { ok: false, error: "Enter the one-time code for the payee steps; use “Get a code” to issue one." };
  const out = new FormData();
  out.set("tax_form", file, file.name || (kind === "w9" ? "w9.pdf" : "w8ben.pdf"));
  out.set("kind", kind);
  out.set("code", code);
  return { ok: true, form: out };
}

export interface PrizePayeeBody {
  legal_name: string;
  country: string;
  us_person: boolean;
  has_tin: boolean;
  treaty_position: boolean;
  code: string;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "yes" || value === "on") return true;
  if (value === "false" || value === "no" || value === "off" || value === "" || value === undefined || value === null) return false;
  return null;
}

/**
 * The payee step (POST /prize-claims/:id/payee). The API reads legal_name,
 * country (alpha-2), us_person, has_tin, treaty_position, and the code;
 * has_tin and treaty_position decide the withholding, and both default to
 * false at the API, so they are always sent explicitly. An address is not
 * part of the contract and is never forwarded.
 */
export function payeeBodyFromRequest(raw: unknown): { ok: true; body: PrizePayeeBody } | { ok: false; error: string } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const legalName = String(b.legal_name ?? "").trim();
  if (!legalName) return { ok: false, error: "Your legal name is required." };
  const country = String(b.country ?? "").trim().toUpperCase();
  if (!isCountryCode(country)) {
    return { ok: false, error: "Give your country of residence as its two-letter code, such as GB or DE." };
  }
  const usPerson = typeof b.us_person === "boolean" ? b.us_person : asBoolean(b.us_person);
  if (usPerson === null || b.us_person === undefined || b.us_person === null || b.us_person === "") {
    return { ok: false, error: "Say whether you are a U.S. person." };
  }
  const hasTin = asBoolean(b.has_tin);
  const treaty = asBoolean(b.treaty_position);
  if (hasTin === null || treaty === null) return { ok: false, error: "Invalid request." };
  const code = String(b.code ?? "").trim();
  if (!code) return { ok: false, error: "Enter the one-time code for the payee steps; use “Get a code” to issue one." };
  return {
    ok: true,
    body: { legal_name: legalName, country, us_person: usPerson, has_tin: hasTin, treaty_position: treaty, code },
  };
}

export type PrizeStep = "payee" | "tax_form" | "code" | "withdraw";

/**
 * A plain sentence for each refusal the claimant's routes emit
 * (src/routes/prizes.ts): CODE_REQUIRED, SESSION_REQUIRED, FORBIDDEN,
 * NOT_FOUND, BAD_PURPOSE, INVALID_SUBMISSION, and the three *_REFUSED codes
 * whose message says what was wrong.
 */
export function prizeStepSentence(err: { code?: string; status: number; message: string }, step: PrizeStep): string {
  const m = err.message ?? "";
  switch (err.code) {
    case "CODE_REQUIRED":
      return "The one-time code is missing, wrong, expired, or was issued for a different step. Use “Get a code” to issue a fresh one for this step and enter it exactly as shown.";
    case "SESSION_REQUIRED":
      return "This step can only be taken from the account page while signed in; an API key cannot take it.";
    case "FORBIDDEN":
      return step === "code"
        ? "Only the claimant can be issued a code for this prize."
        : "Only the claimant can complete the steps for this prize.";
    case "NOT_FOUND":
      return "This prize claim no longer exists.";
    case "BAD_PURPOSE":
      return "A code is issued for the payee steps or for a withdrawal, nothing else.";
    case "INVALID_SUBMISSION":
      return "The upload could not be read: attach one file of at most 10 MiB.";
    case "PAYEE_REFUSED":
    case "TAX_FORM_REFUSED":
    case "WITHDRAW_REFUSED": {
      if (/alpha-2/i.test(m)) return "Give your country of residence as its two-letter code, such as GB or DE.";
      if (/cannot lawfully be paid/i.test(m)) return "Prizes cannot lawfully be paid to residents of that country, so the details were not recorded.";
      if (/legal name/i.test(m)) return "Your legal name is required.";
      if (/kind must be/i.test(m)) return "Say whether the form is a W-9 or a W-8BEN.";
      if (/only the winner|only the claimant/i.test(m)) return "Only the claimant can complete the steps for this prize.";
      if (/follow payable/i.test(m)) return "This prize claim is not payable yet, so the steps cannot be completed.";
      if (/already/i.test(m)) return "This prize claim has already been settled and cannot be withdrawn.";
      if (/not found/i.test(m)) return "This prize claim no longer exists.";
      if (/PDF|plain-text|empty|exceeds/i.test(m)) return "The file was refused: it must be a PDF (or plain text) of the completed form, at most 10 MiB.";
      const what = step === "tax_form" ? "The form" : step === "withdraw" ? "The withdrawal" : "The details";
      return m ? `${what} could not be recorded: ${m.replace(/\.$/, "")}.` : `${what} could not be recorded.`;
    }
    default:
      if (err.status >= 500) return "The Minerval API is not answering; please try again later.";
      return m || "The request could not be completed.";
  }
}
