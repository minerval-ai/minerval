import { describe, it, expect } from "vitest";

// The web's prize forms against the API's contracts (src/routes/prizes.ts,
// docs/mathematics.md §8.4, §8.7): the multipart the filing and the tax-form
// upload receive, the JSON the payee step receives, and the sentences the
// API's refusal codes become. Pure over FormData, so it tests without a
// request or a DOM.
import {
  buildPrizeClaimApiForm,
  buildTaxFormApiForm,
  payeeBodyFromRequest,
  prizeStepSentence,
} from "../../../web/lib/prize-forms";

const LEAN = "theorem Minerval.S00000000_v1.proof : True := trivial\n";

function filing(overrides: Record<string, string | File | null> = {}, extraDocs: File[] = []): FormData {
  const f = new FormData();
  const base: Record<string, string | File | null> = {
    formalization_id: "f-1",
    statement_version: "1",
    direction: "proof",
    content: "A written account of the approach, in the claimant's own words. ".repeat(5),
    links: "https://example.org/a\nhttps://example.org/b",
    lean_mode: "file",
    lean_file: new File([LEAN], "proof.lean", { type: "text/plain" }),
    lean_source: "",
    tools_disclosure: "Lean 4 with Mathlib; no AI assistance.",
    residency_country: "gb",
    us_person: "no",
    credit_name: "Ada",
    declare_eligible: "on",
    declare_understands: "on",
    declare_cc0: "on",
    declare_rules: "on",
    rules_version: "2026-09-01",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === null) continue;
    if (typeof v === "string") f.set(k, v);
    else f.set(k, v, v.name);
  }
  for (const d of extraDocs) f.append("documents", d, d.name);
  return f;
}

describe("buildPrizeClaimApiForm", () => {
  it("rebuilds the filing under exactly the field names the API reads", () => {
    const r = buildPrizeClaimApiForm(filing({}, [new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.form;
    expect([...out.keys()].sort()).toEqual(
      ["content", "credit_name", "declarations", "direction", "documents", "formalization_id",
        "lean_source", "links", "residency_country", "rules_version", "tools_disclosure", "us_person"].sort()
    );
    expect(out.get("formalization_id")).toBe("f-1");
    expect(out.get("direction")).toBe("proof");
    expect(out.get("credit_name")).toBe("Ada");
    expect(out.get("rules_version")).toBe("2026-09-01");
    expect(out.get("tools_disclosure")).toBe("Lean 4 with Mathlib; no AI assistance.");
    // The API takes links as a JSON array, the country as upper-case alpha-2,
    // and the U.S.-person answer as "true" | "false".
    expect(JSON.parse(String(out.get("links")))).toEqual(["https://example.org/a", "https://example.org/b"]);
    expect(out.get("residency_country")).toBe("GB");
    expect(out.get("us_person")).toBe("false");
    // The four checkboxes become the declarations object the gate checks.
    expect(JSON.parse(String(out.get("declarations")))).toEqual({
      eligibility: true, understanding: true, cc0: true, rules: true,
    });
    // The Lean file is the `lean_source` part; the documents keep their part name.
    const lean = out.get("lean_source") as File;
    expect(lean).toBeInstanceOf(File);
    expect(lean.name).toBe("proof.lean");
    expect(out.get("lean_source_text")).toBeNull();
    const docs = out.getAll("documents") as File[];
    expect(docs).toHaveLength(1);
    expect(docs[0]!.name).toBe("notes.pdf");
    // The form's presentational fields never reach the API.
    for (const k of ["lean_mode", "statement_version", "lean_file", "declare_eligible", "declare_rules", "contributor_display_name"]) {
      expect(out.has(k)).toBe(false);
    }
  });

  it("sends pasted source as lean_source_text and no file part", () => {
    const r = buildPrizeClaimApiForm(filing({ lean_file: null, lean_source: LEAN, us_person: "yes", links: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form.get("lean_source_text")).toBe(LEAN);
    expect(r.form.has("lean_source")).toBe(false);
    expect(r.form.get("us_person")).toBe("true");
    expect(r.form.get("links")).toBe("[]");
  });

  it("refuses before the round trip what the API would refuse", () => {
    const err = (o: Record<string, string | File | null>) => {
      const r = buildPrizeClaimApiForm(filing(o));
      return r.ok ? null : r.error;
    };
    expect(err({ declare_cc0: "" })).toMatch(/Each declaration/);
    expect(err({ declare_rules: null })).toMatch(/Each declaration/);
    expect(err({ us_person: "" })).toMatch(/U\.S\. person/);
    expect(err({ residency_country: "United Kingdom" })).toMatch(/two-letter code/);
    expect(err({ direction: "maybe" })).toMatch(/proof or a disproof/);
    expect(err({ content: "short" })).toMatch(/between 200 and/);
    expect(err({ lean_file: null, lean_source: "" })).toMatch(/Attach the Lean file or paste/);
    expect(err({ links: "ftp://x" })).toMatch(/full web addresses/);
    expect(err({ tools_disclosure: " " })).toMatch(/tools/);
    expect(err({ credit_name: "" })).toMatch(/credit name/);
    expect(err({ formalization_id: "" })).toMatch(/statement version/);
    expect(err({ rules_version: "" })).toMatch(/rules version/);
  });

  it("keeps the attachment limits", () => {
    const big = new File([new Uint8Array(256 * 1024 + 1)], "big.lean");
    const r = buildPrizeClaimApiForm(filing({ lean_file: big }));
    expect(r.ok).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => new File(["x"], `d${i}.txt`));
    expect(buildPrizeClaimApiForm(filing({}, six)).ok).toBe(false);
  });
});

describe("buildTaxFormApiForm", () => {
  it("sends the file as tax_form with kind and the code", () => {
    const f = new FormData();
    f.set("tax_form", new File(["%PDF-1.4"], "w9.pdf", { type: "application/pdf" }), "w9.pdf");
    f.set("kind", "w9");
    f.set("code", "abc.def");
    const r = buildTaxFormApiForm(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.form.keys()].sort()).toEqual(["code", "kind", "tax_form"]);
    expect((r.form.get("tax_form") as File).name).toBe("w9.pdf");
    expect(r.form.get("kind")).toBe("w9");
    expect(r.form.get("code")).toBe("abc.def");
  });

  it("still accepts the older browser names, and refuses a missing code, file, or kind", () => {
    const f = new FormData();
    f.set("file", new File(["%PDF-1.4"], "w8.pdf"), "w8.pdf");
    f.set("form_kind", "w8ben");
    expect(buildTaxFormApiForm(f)).toMatchObject({ ok: false, error: expect.stringMatching(/one-time code/) });
    f.set("code", "abc.def");
    const r = buildTaxFormApiForm(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.form.get("kind")).toBe("w8ben");
    f.set("form_kind", "1099");
    expect(buildTaxFormApiForm(f)).toMatchObject({ ok: false, error: expect.stringMatching(/W-9 or a W-8BEN/) });
    const empty = new FormData();
    empty.set("kind", "w9");
    empty.set("code", "x.y");
    expect(buildTaxFormApiForm(empty)).toMatchObject({ ok: false, error: "Attach the completed form." });
  });
});

describe("payeeBodyFromRequest", () => {
  it("forwards legal_name, country, us_person, has_tin, treaty_position, and code, and never an address", () => {
    const r = payeeBodyFromRequest({
      legal_name: " Ada Lovelace ", address: "1 Street", country: "gb", us_person: false,
      has_tin: false, treaty_position: true, code: " abc.def ",
    });
    expect(r).toEqual({
      ok: true,
      body: { legal_name: "Ada Lovelace", country: "GB", us_person: false, has_tin: false, treaty_position: true, code: "abc.def" },
    });
  });

  it("sends has_tin and treaty_position as explicit booleans, false when unticked", () => {
    const r = payeeBodyFromRequest({ legal_name: "Ada", country: "US", us_person: true, code: "x.y" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({ has_tin: false, treaty_position: false });
    const ticked = payeeBodyFromRequest({ legal_name: "Ada", country: "US", us_person: true, has_tin: true, code: "x.y" });
    if (ticked.ok) expect(ticked.body.has_tin).toBe(true);
  });

  it("refuses what the API would refuse, in plain words", () => {
    expect(payeeBodyFromRequest({ country: "GB", us_person: true, code: "x" })).toMatchObject({ ok: false, error: "Your legal name is required." });
    expect(payeeBodyFromRequest({ legal_name: "A", country: "United Kingdom", us_person: true, code: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/two-letter code/) });
    expect(payeeBodyFromRequest({ legal_name: "A", country: "GB", code: "x" })).toMatchObject({ ok: false, error: "Say whether you are a U.S. person." });
    expect(payeeBodyFromRequest({ legal_name: "A", country: "GB", us_person: false })).toMatchObject({ ok: false, error: expect.stringMatching(/one-time code/) });
  });
});

describe("prizeStepSentence", () => {
  it("turns each of the route's codes into a sentence", () => {
    expect(prizeStepSentence({ code: "CODE_REQUIRED", status: 403, message: "a valid one-time code for this prize claim is required" }, "payee")).toMatch(/Get a code/);
    expect(prizeStepSentence({ code: "SESSION_REQUIRED", status: 403, message: "" }, "payee")).toMatch(/signed in/);
    expect(prizeStepSentence({ code: "FORBIDDEN", status: 403, message: "only the claimant receives a code" }, "code")).toMatch(/Only the claimant/);
    expect(prizeStepSentence({ code: "NOT_FOUND", status: 404, message: "prize claim not found" }, "code")).toMatch(/no longer exists/);
    expect(prizeStepSentence({ code: "BAD_PURPOSE", status: 422, message: "purpose must be withdraw or payee" }, "code")).toMatch(/payee steps or for a withdrawal/);
    expect(prizeStepSentence({ code: "INVALID_SUBMISSION", status: 422, message: "unreadable multipart body" }, "tax_form")).toMatch(/could not be read/);
  });

  it("reads the message behind PAYEE_REFUSED and TAX_FORM_REFUSED", () => {
    const payee = (m: string) => prizeStepSentence({ code: "PAYEE_REFUSED", status: 422, message: m }, "payee");
    expect(payee("country must be ISO 3166-1 alpha-2")).toMatch(/two-letter code/);
    expect(payee("prizes cannot lawfully be paid to residents of IT")).toMatch(/cannot lawfully be paid/);
    expect(payee("a legal name is required")).toBe("Your legal name is required.");
    expect(payee("only the winner records the payee")).toMatch(/Only the claimant/);
    expect(payee("prize claim is in_review; the payee steps follow payable")).toMatch(/not payable yet/);
    const tax = (m: string) => prizeStepSentence({ code: "TAX_FORM_REFUSED", status: 422, message: m }, "tax_form");
    expect(tax("kind must be w9 or w8ben")).toMatch(/W-9 or a W-8BEN/);
    expect(tax("a tax form must be a PDF or a plain-text file")).toMatch(/must be a PDF/);
    expect(tax("something else")).toBe("The form could not be recorded: something else.");
  });

  it("falls back to the API's message, or a retry sentence on a server error", () => {
    expect(prizeStepSentence({ code: "OTHER", status: 409, message: "moved" }, "payee")).toBe("moved");
    expect(prizeStepSentence({ status: 502, message: "Minerval API 502 for /x" }, "payee")).toMatch(/try again later/);
  });
});
