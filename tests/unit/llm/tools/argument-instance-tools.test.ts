import { describe, it, expect, vi, beforeEach } from "vitest";

// record_argument_instance (#541): where a source makes, attacks or mentions
// an argument. Provenance only: it never touches the argument's written form,
// and retired arguments take instances too.

const OWN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ARG = "44444444-4444-4444-4444-444444444444";
const SOURCE = "55555555-5555-5555-5555-555555555555";
const INST = "66666666-6666-6666-6666-666666666666";

const { usage } = vi.hoisted(() => ({
  usage: { claimId: "11111111-1111-1111-1111-111111111111" as string | undefined },
}));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
}));

vi.mock("../../../../src/llm/usage-context.js", () => ({
  getUsageContext: () => usage,
}));

vi.mock("../../../../src/services/argument-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/argument-service.js")>()),
  getArgument: vi.fn(),
}));

vi.mock("../../../../src/services/argument-instance-service.js", () => ({
  findArgumentInstance: vi.fn(async () => null),
  insertArgumentInstance: vi.fn(async () => "77777777-7777-7777-7777-777777777777"),
  updateArgumentInstance: vi.fn(async () => true),
}));

vi.mock("../../../../src/services/source-service.js", () => ({
  getOrCreateSource: vi.fn(async ({ url }: { url: string }) => ({ id: SOURCE, url })),
}));

import {
  executeArgumentInstanceTool,
  getArgumentInstanceToolDefinition,
  getResearcherArgumentInstanceToolDefinition,
} from "../../../../src/llm/tools/argument-instance-tools.js";
import { getStewardToolDefinitions } from "../../../../src/llm/tools/steward-tools.js";
import { getArgument } from "../../../../src/services/argument-service.js";
import {
  findArgumentInstance,
  insertArgumentInstance,
  updateArgumentInstance,
} from "../../../../src/services/argument-instance-service.js";

function argument(over: Record<string, unknown> = {}) {
  return {
    id: ARG,
    claimId: OWN,
    name: "the argument from unlinked early cases",
    stance: "for",
    retiredAt: null,
    retiredReason: null,
    ...over,
  };
}

const NEW = {
  argument_id: ARG,
  url: "https://example.org/paper",
  verbatim_text: "Since the earliest cases had no link to the market, the outbreak began elsewhere.",
  stance: "advances",
  reading: "premise_unstated",
};

function parse(out: string | null) {
  return JSON.parse(out!) as { success: boolean; message: string; instance_id?: string; deduplicated?: boolean };
}

beforeEach(() => {
  vi.clearAllMocks();
  usage.claimId = OWN;
  vi.mocked(getArgument).mockResolvedValue(argument() as never);
  vi.mocked(findArgumentInstance).mockResolvedValue(null);
});

describe("record_argument_instance", () => {
  it("is in the Steward's toolset, and the researcher's version cannot correct", () => {
    expect(getStewardToolDefinitions().map((t) => t.name)).toContain("record_argument_instance");
    const steward = getArgumentInstanceToolDefinition().input_schema as { properties: Record<string, unknown> };
    const researcher = getResearcherArgumentInstanceToolDefinition().input_schema as {
      properties: Record<string, unknown>;
    };
    expect(steward.properties).toHaveProperty("instance_id");
    expect(researcher.properties).not.toHaveProperty("instance_id");
  });

  it("returns null for a tool it does not own", async () => {
    expect(await executeArgumentInstanceTool("record_claim_instance", {})).toBeNull();
  });

  it("records a passage on the run's own argument", async () => {
    const out = parse(await executeArgumentInstanceTool("record_argument_instance", NEW));
    expect(out.success).toBe(true);
    expect(insertArgumentInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        argumentId: ARG,
        sourceId: SOURCE,
        stance: "advances",
        reading: "premise_unstated",
        createdBy: "claim_steward",
      })
    );
  });

  it("refuses an argument on another node", async () => {
    vi.mocked(getArgument).mockResolvedValue(argument({ claimId: OTHER }) as never);
    const out = parse(await executeArgumentInstanceTool("record_argument_instance", NEW));
    expect(out.success).toBe(false);
    expect(insertArgumentInstance).not.toHaveBeenCalled();
  });

  it("holds a researcher to the run's node", async () => {
    usage.claimId = undefined;
    vi.mocked(getArgument).mockResolvedValue(argument({ claimId: OTHER }) as never);
    const out = parse(
      await executeArgumentInstanceTool("record_argument_instance", NEW, { recordedBy: "researcher", nodeId: OWN })
    );
    expect(out.success).toBe(false);
    expect(out.message).toContain("the node this run serves");
  });

  it("records on a retired argument without bringing it back", async () => {
    vi.mocked(getArgument).mockResolvedValue(
      argument({ retiredAt: new Date(), retiredReason: "answered by later evidence" }) as never
    );
    const out = parse(await executeArgumentInstanceTool("record_argument_instance", NEW));
    expect(out.success).toBe(true);
    expect(out.message).toContain("does not bring it back");
    expect(insertArgumentInstance).toHaveBeenCalled();
  });

  it("gives a mention no reading", async () => {
    const refused = parse(
      await executeArgumentInstanceTool("record_argument_instance", { ...NEW, stance: "mentions", reading: "full" })
    );
    expect(refused.success).toBe(false);
    const { reading: _reading, ...mention } = NEW;
    parse(await executeArgumentInstanceTool("record_argument_instance", { ...mention, stance: "mentions" }));
    expect(insertArgumentInstance).toHaveBeenCalledWith(expect.objectContaining({ stance: "mentions", reading: null }));
  });

  it("refuses an unknown stance or reading", async () => {
    expect(parse(await executeArgumentInstanceTool("record_argument_instance", { ...NEW, stance: "affirms" })).success).toBe(false);
    expect(parse(await executeArgumentInstanceTool("record_argument_instance", { ...NEW, reading: "weak" })).success).toBe(false);
  });

  it("takes a stated value only on an argument about a quantity", async () => {
    const shows = { text: "between 2 and 3", range: { side: "between", low: 2, high: 3 } };
    const onProposition = parse(
      await executeArgumentInstanceTool("record_argument_instance", { ...NEW, stated_shows: shows })
    );
    expect(onProposition.success).toBe(false);
    vi.mocked(getArgument).mockResolvedValue(argument({ stance: "neutral" }) as never);
    const onQuantity = parse(
      await executeArgumentInstanceTool("record_argument_instance", { ...NEW, stated_shows: shows })
    );
    expect(onQuantity.success).toBe(true);
    expect(insertArgumentInstance).toHaveBeenCalledWith(expect.objectContaining({ statedShows: shows }));
  });

  it("deduplicates on (argument, source, speaker)", async () => {
    vi.mocked(findArgumentInstance).mockResolvedValue({
      id: INST,
      stance: "criticizes",
      reading: "strawman",
      speaker: null,
    });
    const out = parse(await executeArgumentInstanceTool("record_argument_instance", NEW));
    expect(out.deduplicated).toBe(true);
    expect(out.instance_id).toBe(INST);
    expect(out.message).toContain("differs");
    expect(insertArgumentInstance).not.toHaveBeenCalled();
  });

  it("lets the Steward correct an instance, and not a researcher", async () => {
    const steward = parse(
      await executeArgumentInstanceTool("record_argument_instance", {
        argument_id: ARG,
        instance_id: INST,
        reading: "full",
      })
    );
    expect(steward.success).toBe(true);
    expect(updateArgumentInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: INST, argumentId: ARG, reading: "full" })
    );
    const researcher = parse(
      await executeArgumentInstanceTool(
        "record_argument_instance",
        { argument_id: ARG, instance_id: INST, reading: "full" },
        { recordedBy: "researcher", nodeId: OWN }
      )
    );
    expect(researcher.success).toBe(false);
  });
});
