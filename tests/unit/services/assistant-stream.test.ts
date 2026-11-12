import { describe, it, expect } from "vitest";
import {
  assistantStreamIsLive,
  assistantStreamState,
  openAssistantStream,
  publishAssistantEvent,
  subscribeAssistantStream,
  type AssistantStreamEvent,
} from "../../../src/services/assistant-stream.js";

/**
 * The live path beside a turn's saved state: events reach whoever is
 * listening as they are published, and a watcher who joins part-way is given
 * what the turn has so far.
 */
describe("assistant turn stream", () => {
  it("forwards events to listeners, and says done when the turn ends", () => {
    const heard: AssistantStreamEvent[] = [];
    const stream = openAssistantStream("c1");
    const off = subscribeAssistantStream("c1", (e) => heard.push(e));
    publishAssistantEvent("c1", { type: "activity", tool: "search_claims", about: "eggs" });
    publishAssistantEvent("c1", { type: "text", turn: 0, delta: "It " });
    publishAssistantEvent("other", { type: "text", turn: 0, delta: "not ours" });
    stream.end();
    off();
    publishAssistantEvent("c1", { type: "note", note: "after leaving" });
    expect(heard).toEqual([
      { type: "activity", tool: "search_claims", about: "eggs" },
      { type: "text", turn: 0, delta: "It " },
      { type: "done" },
    ]);
  });

  it("keeps what a running turn has so far, for a watcher who joins late", () => {
    expect(assistantStreamIsLive("c2")).toBe(false);
    expect(assistantStreamState("c2")).toBeNull();
    const stream = openAssistantStream("c2");
    expect(assistantStreamIsLive("c2")).toBe(true);
    publishAssistantEvent("c2", { type: "activity", tool: "search_claims", about: "eggs" });
    publishAssistantEvent("c2", { type: "note", note: "Reading" });
    publishAssistantEvent("c2", { type: "text", turn: 0, delta: "Looking " });
    publishAssistantEvent("c2", { type: "text", turn: 0, delta: "it up." });
    expect(assistantStreamState("c2")).toEqual({
      partial: "Looking it up.",
      turn: 0,
      note: "Reading",
      activity: [{ tool: "search_claims", about: "eggs" }],
    });
    // A new model turn starts the text over.
    publishAssistantEvent("c2", { type: "text", turn: 1, delta: "It is " });
    expect(assistantStreamState("c2")).toMatchObject({ partial: "It is ", turn: 1 });
    // Only the latest steps are kept.
    for (let i = 0; i < 20; i++) publishAssistantEvent("c2", { type: "activity", tool: `t${i}`, about: null });
    expect(assistantStreamState("c2")!.activity).toHaveLength(12);
    expect(assistantStreamState("c2")!.activity.at(-1)).toEqual({ tool: "t19", about: null });
    stream.end();
    expect(assistantStreamIsLive("c2")).toBe(false);
    expect(assistantStreamState("c2")).toBeNull();
  });
});
