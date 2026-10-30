/**
 * Validate a MIRA export against MIRA's own SHACL shapes (docs/mira/, pinned
 * from MIRA-science/schema). Mirrors the schema repo's `make validate_data`,
 * which runs pyshacl with mira.ttl as the ontology: the ontology contributes
 * the class hierarchy (Claim and Evidence are mira:Argument, a Study is a
 * prov:Activity), which sh:class needs. Only its rdfs:subClassOf triples are
 * merged here, since rdf-validate-shacl would otherwise also validate the
 * ontology's own property declarations; on MIRA's sample data and on a
 * closed-shape violation this gives pyshacl's verdicts.
 *
 * MIRA's context is served from the vendored copy, so no test fetches it.
 */
import { readFileSync } from "fs";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import rdf from "@zazuko/env-node";
import SHACLValidator from "rdf-validate-shacl";
import jsonld from "jsonld";
import { MIRA_CONTEXT_URL } from "../src/services/mira-service.js";

const dir = fileURLToPath(new URL("../docs/mira/", import.meta.url));
const context = JSON.parse(readFileSync(`${dir}mira.jsonld`, "utf8"));

async function parseTurtle(path: string) {
  return rdf.dataset().import(rdf.formats.parsers.import("text/turtle", Readable.from([readFileSync(path, "utf8")]))!);
}

let shapesAndHierarchy: Promise<{ shapes: unknown; subClassOf: unknown[] }> | null = null;
function load() {
  shapesAndHierarchy ??= (async () => {
    const shapes = await parseTurtle(`${dir}mira.shacl`);
    const ontology = await parseTurtle(`${dir}mira.ttl`);
    const subClassOf = [...ontology].filter(
      (q) =>
        q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#subClassOf" &&
        q.object.termType === "NamedNode"
    );
    return { shapes, subClassOf };
  })();
  return shapesAndHierarchy;
}

const documentLoader = async (url: string) => {
  if (url === MIRA_CONTEXT_URL) return { document: context, documentUrl: url, contextUrl: null };
  throw new Error(`MIRA validation fetches nothing: ${url}`);
};

/** The JSON-LD document as N-Quads, through MIRA's context. */
export async function miraToNQuads(doc: unknown): Promise<string> {
  return (await jsonld.toRDF(doc as jsonld.JsonLdDocument, {
    format: "application/n-quads",
    documentLoader: documentLoader as never,
  })) as unknown as string;
}

export async function validateMira(
  doc: unknown
): Promise<{ conforms: boolean; messages: string[] }> {
  const { shapes, subClassOf } = await load();
  const nquads = await miraToNQuads(doc);
  const data = await rdf
    .dataset()
    .import(rdf.formats.parsers.import("application/n-quads", Readable.from([nquads]))!);
  for (const q of subClassOf) data.add(q as never);
  const report = await new SHACLValidator(shapes as never, { factory: rdf }).validate(data);
  return {
    conforms: report.conforms,
    messages: report.results.map(
      (r) =>
        `${r.focusNode?.value} ${r.path?.value ?? ""}: ${r.message.map((m) => m.value).join("; ") || r.sourceConstraintComponent?.value}`
    ),
  };
}
