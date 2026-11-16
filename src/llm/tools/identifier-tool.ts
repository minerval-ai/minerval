/**
 * resolve_identifier: the address of a paper or a book, from its
 * identifier.
 *
 * Where a run reads material that is not public, a tool takes an address
 * only as it came from outside (services/given-addresses.ts), so a run can
 * no longer write `https://doi.org/` in front of a DOI it holds. This tool
 * is how it gets that address instead. It builds the address from the
 * identifier at a resolver fixed here, records it as given, and returns
 * it. It fetches nothing itself. When the run then reads the address, what
 * goes out is the identifier, in the one place the resolver's address has
 * for it, to a resolver this file names and not to a host some text chose.
 *
 * The identifier's shape is checked so that it cannot be a sentence. An
 * arXiv id, a PubMed id and a PMC id are digits in a fixed pattern, and an
 * ISBN is digits with a check digit. A DOI is the loose one: after its
 * registrant prefix the standard allows almost anything, so its suffix is
 * held to the characters DOIs are made of and to a length, and what could
 * still be written into one reaches doi.org and nobody else, because a DOI
 * that is not registered does not resolve.
 *
 * The loop offers it and runs it (llm/client.ts) wherever the rule applies
 * and the run has a tool that takes an address, so no agent's own code
 * knows of it. It is not offered on the public graph, where an agent
 * writes the address itself as it always has.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { noteGiven, RESOLVE_IDENTIFIER_TOOL_NAME } from "../../services/given-addresses.js";
import {
  DOI_SUFFIX_MAX_CHARS,
  parseArxivIdStrict,
  parseDoi,
  parseIsbn,
  parsePmcid,
  parsePmid,
} from "../../services/identifiers.js";

type Tool = Anthropic.Tool;

export const IDENTIFIER_KINDS = ["doi", "arxiv", "pmid", "pmcid", "isbn"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export interface ResolvedIdentifier {
  kind: IdentifierKind;
  /** The identifier in its checked form. */
  id: string;
  /** The address to read. */
  address: string;
  /** Other addresses for the same thing, where the resolver has them. */
  also?: Record<string, string>;
}

/** The address a fixed resolver has for an identifier, or null when the identifier is not of its kind's shape. */
export function resolveIdentifier(kind: IdentifierKind, raw: string): ResolvedIdentifier | null {
  if (kind === "doi") {
    const id = parseDoi(raw);
    return id ? { kind, id, address: `https://doi.org/${id}` } : null;
  }
  if (kind === "arxiv") {
    const id = parseArxivIdStrict(raw);
    return id
      ? { kind, id, address: `https://arxiv.org/abs/${id}`, also: { pdf: `https://arxiv.org/pdf/${id}` } }
      : null;
  }
  if (kind === "pmid") {
    const id = parsePmid(raw);
    return id ? { kind, id, address: `https://pubmed.ncbi.nlm.nih.gov/${id}/` } : null;
  }
  if (kind === "pmcid") {
    const id = parsePmcid(raw);
    return id ? { kind, id, address: `https://pmc.ncbi.nlm.nih.gov/articles/${id}/` } : null;
  }
  const id = parseIsbn(raw);
  return id ? { kind, id, address: `https://openlibrary.org/isbn/${id}` } : null;
}

const SHAPES: Record<IdentifierKind, string> = {
  doi:
    `a DOI such as 10.1038/s41586-020-2649-2: the prefix, a slash, and a suffix of letters, digits and ` +
    `. _ ; ( ) / : - of at most ${DOI_SUFFIX_MAX_CHARS} characters`,
  arxiv: "an arXiv id such as 2401.01234, 2401.01234v2 or hep-th/9901001",
  pmid: "a PubMed id: up to nine digits",
  pmcid: "a PubMed Central id such as PMC1234567",
  isbn: "an ISBN of ten or thirteen digits with a correct check digit",
};

export function getResolveIdentifierToolDefinition(): Tool {
  return {
    name: RESOLVE_IDENTIFIER_TOOL_NAME,
    description:
      "Get the address of a paper or a book from its identifier: a DOI, an arXiv id, a PubMed id, a " +
      "PubMed Central id or an ISBN. On this graph a tool takes an address only as it came from " +
      "outside, so you cannot write the address of a DOI yourself; this returns it, and read_page " +
      "and the other tools then take it. It fetches nothing: it builds the address at a fixed " +
      "resolver (doi.org, arxiv.org, pubmed.ncbi.nlm.nih.gov, pmc.ncbi.nlm.nih.gov, " +
      "openlibrary.org), so it does not tell you whether the identifier exists; reading the " +
      "address does. The identifier must have its kind's shape and is refused otherwise, with the " +
      "shape expected.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", enum: [...IDENTIFIER_KINDS] },
        id: { type: "string", description: "The identifier alone, for example 10.1038/s41586-020-2649-2." },
      },
      required: ["kind", "id"],
    },
  };
}

/** Run resolve_identifier; null for any other tool. */
export async function executeResolveIdentifier(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (name !== RESOLVE_IDENTIFIER_TOOL_NAME) return null;
  const kind = String(input.kind ?? "") as IdentifierKind;
  if (!IDENTIFIER_KINDS.includes(kind)) {
    return JSON.stringify({ ok: false, problem: `kind must be one of ${IDENTIFIER_KINDS.join(", ")}.` });
  }
  const resolved = resolveIdentifier(kind, String(input.id ?? ""));
  if (!resolved) {
    return JSON.stringify({
      ok: false,
      problem:
        `Not resolved: the id is not ${SHAPES[kind]}. The shape is checked so that an identifier ` +
        `cannot carry other text out. Pass the identifier alone.`,
    });
  }
  await noteGiven([resolved.address, ...Object.values(resolved.also ?? {})], "identifier");
  return JSON.stringify({ ok: true, ...resolved });
}
