/**
 * The kinds of act the administrative log is filtered by
 * (src/services/permission-service.ts, LOG_TYPE_OF): one place says which
 * event is which kind, and the Activity log shows the API's word.
 */
import { describe, expect, it } from "vitest";
import { LOG_TYPES, LOG_TYPE_OF, logTypeOf } from "../../../src/services/permission-service.js";

describe("the log's kinds", () => {
  it("gives every event a kind, the file sets' acts their own", () => {
    for (const [event, type] of Object.entries(LOG_TYPE_OF)) expect(LOG_TYPES, event).toContain(type);
    expect(logTypeOf("granted")).toBe("access");
    expect(logTypeOf("removed")).toBe("access");
    expect(logTypeOf("label_face_shown")).toBe("labels");
    expect(logTypeOf("own_organization_named")).toBe("parties");
    expect(logTypeOf("source_party_set")).toBe("parties");
    expect(logTypeOf("connection_tool_withdrawn")).toBe("connections");
    expect(logTypeOf("provider_clearance_set")).toBe("providers");
    expect(logTypeOf("owls_created")).toBe("owls");
    expect(logTypeOf("standing_mandate_created")).toBe("mandates");
    for (const event of ["file_set_added", "file_set_closed", "file_set_changed"]) expect(logTypeOf(event)).toBe("file_sets");
  });

  it("calls an event this build does not know other, and every kind but other is some event's", () => {
    expect(logTypeOf("something_new")).toBe("other");
    const used = new Set(Object.values(LOG_TYPE_OF));
    for (const type of LOG_TYPES) expect(used.has(type), type).toBe(true);
  });
});
