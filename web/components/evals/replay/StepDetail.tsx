"use client";

import { useState } from "react";
import { promptSpecOf, promptText, type ReplayArm, type ReplayEvent, type ReplayStep, type ReplayToolDef } from "@/lib/replay-core";
import { modelDisplayName } from "@/lib/model-names";
import { JsonTree } from "./JsonTree";
import { useEventDetail } from "./useEventDetail";
import { agentMeta, describeDelta, fmtChars, fmtTime, stepGist, stepKindLabel } from "./vocab";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// Level (d): one step, verbatim. The detail file is fetched when the panel
// opens; until it arrives (or when there is none) the index's trimmed record
// is shown and labelled as such. A prompt step shows the system prompt blocks,
// the initial messages and the tool definitions with their JSON schemas; a
// tool call shows its full input and the tool's definition on request; a
// decision shows the same plus what it changed in the graph.

export function StepDetail({
  replayName, arm, event, stepIndex, nav, texts,
}: {
  replayName: string;
  arm: ReplayArm;
  event: ReplayEvent;
  stepIndex: number;
  nav: Nav;
  texts: (id: string) => string | null;
}) {
  const detail = useEventDetail(replayName, arm.key, event, true);
  const full = detail.status === "ready" ? detail.detail : null;
  const steps = full?.steps?.length ? full.steps : event.steps;
  const step = steps[stepIndex];
  const isFull = !!(full && step && (step.full ?? true));
  // The tool definitions come from the event's prompt step, when it has one.
  const promptStep = steps.find((x) => x.kind === "prompt");
  const tools = promptStep ? promptSpecOf(promptStep)?.tools ?? [] : [];

  if (!step) return <p className={s.dim}>This event has no step {stepIndex + 1}.</p>;

  return (
    <div className={s.stepDetail}>
      <div className={s.stepNav}>
        <button type="button" className={s.tbtn} disabled={stepIndex <= 0} onClick={() => nav.openStep(arm.key, event.seq, stepIndex - 1)} title="Previous step ([)">←</button>
        <span className={s.counter}>step {stepIndex + 1} / {steps.length}</span>
        <button type="button" className={s.tbtn} disabled={stepIndex >= steps.length - 1} onClick={() => nav.openStep(arm.key, event.seq, stepIndex + 1)} title="Next step (])">→</button>
        <span className={s.nowMeta}>{stepKindLabel(step.kind)}{step.tool ? <> · <code>{step.tool}</code></> : null} · {fmtTime(step.at)}</span>
      </div>

      <p className={s.fidelity}>
        {detail.status === "loading" ? "Loading the verbatim record…" : null}
        {detail.status === "missing" ? "No detail file was vendored for this event: what follows is the index's trimmed record." : null}
        {detail.status === "error" ? `Could not load the detail file (${detail.message}); showing the index's trimmed record.` : null}
        {detail.status === "ready" && isFull ? "Verbatim, from the detail file." : null}
        {detail.status === "ready" && !isFull ? "The detail file carries this step trimmed." : null}
        {step.truncated && !isFull ? " Marked trimmed by the exporter." : null}
      </p>

      {step.kind === "prompt" ? <PromptView step={step} /> : null}

      {step.kind === "thought" || step.kind === "completion" ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>{step.kind === "thought" ? "The agent wrote" : "Output"}</p>
          <pre className={s.verbatim}>{step.text}</pre>
        </>
      ) : null}

      {step.kind === "tool_call" || step.kind === "decision" ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>{step.kind === "decision" ? "Decision" : "Call"} · <span className={s.dim}>gist: {stepGist(step)}</span></p>
          <p className={`sc ${s.stepsLabel}`}>Input{step.sizes?.input ? <span className={s.dim}> · {fmtChars(step.sizes.input)}</span> : null}</p>
          <JsonTree value={step.input} />
          {step.output !== undefined ? (
            <>
              <p className={`sc ${s.stepsLabel}`}>Returned</p>
              <JsonTree value={step.output} />
            </>
          ) : null}
          {step.tool ? <ToolDef name={step.tool} tools={tools} /> : null}
        </>
      ) : null}

      {step.kind === "tool_result" ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>Output{step.sizes?.output ? <span className={s.dim}> · {fmtChars(step.sizes.output)}</span> : null} · <span className={s.dim}>gist: {stepGist(step)}</span></p>
          <JsonTree value={step.output ?? step.text} />
          {step.tool ? <ToolDef name={step.tool} tools={tools} /> : null}
        </>
      ) : null}

      {!["prompt", "thought", "completion", "tool_call", "decision", "tool_result"].includes(step.kind) ? (
        <>
          <pre className={s.verbatim}>{step.text}</pre>
          {step.input !== undefined ? <JsonTree value={step.input} /> : null}
          {step.output !== undefined ? <JsonTree value={step.output} /> : null}
        </>
      ) : null}

      {step.kind === "decision" && event.deltas.length > 0 ? (
        <>
          <p className={`sc ${s.stepsLabel}`}>What it changed in the graph <span className={s.dim}>· attribution: {event.attribution}</span></p>
          <ul className={s.deltaList}>
            {event.deltas.map((d, i) => <li key={i}>{describeDelta(d, texts)}</li>)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PromptView({ step }: { step: ReplayStep }) {
  const spec = promptSpecOf(step);
  if (!spec) {
    return <p className={s.dim}>The index records that a prompt was sent ({step.text}{step.sizes?.system ? `, ${fmtChars(step.sizes.system)} of system prompt` : ""}); the text is in the detail file.</p>;
  }
  const system = spec.system;
  const blocks = Array.isArray(system) ? system : system ? [{ type: "text", text: system }] : [];
  return (
    <div>
      <p className={s.nowMeta}>
        {spec.model ? <>model <strong>{modelDisplayName(spec.model)}</strong> <code>{spec.model}</code></> : null}
        {spec.effort ? <> · effort {spec.effort}</> : null}
        {spec.maxTokens ? <> · max tokens {spec.maxTokens}</> : null}
        {spec.sha256 ? <> · <code title="sha256 of the system prompt">{spec.sha256.slice(0, 12)}</code></> : null}
      </p>
      <p className={`sc ${s.stepsLabel}`}>System prompt{blocks.length > 1 ? <span className={s.dim}> · {blocks.length} blocks</span> : null}{step.sizes?.system ? <span className={s.dim}> · {fmtChars(step.sizes.system)}</span> : null}</p>
      {blocks.length === 0 ? <p className={s.dim}>none recorded</p> : blocks.map((b, i) => (
        <details key={i} className={s.block} open={i === 0}>
          <summary>block {i + 1}{b.type && b.type !== "text" ? ` · ${b.type}` : ""}{typeof b.text === "string" ? <span className={s.dim}> · {fmtChars(b.text.length)}</span> : null}</summary>
          {typeof b.text === "string" ? <pre className={s.verbatim}>{b.text}</pre> : <JsonTree value={b} />}
        </details>
      ))}
      <p className={`sc ${s.stepsLabel}`}>Initial messages{spec.initialMessages?.length ? <span className={s.dim}> · {spec.initialMessages.length}</span> : null}</p>
      {spec.initialMessages?.length ? spec.initialMessages.map((m, i) => (
        <div key={i} className={s.msg}>
          <span className={s.msgRole}>{m.role ?? "message"}</span>
          {typeof m.content === "string" ? <pre className={s.verbatim}>{m.content}</pre> : <JsonTree value={m.content} />}
        </div>
      )) : <p className={s.dim}>none recorded</p>}
      <p className={`sc ${s.stepsLabel}`}>Tools{spec.tools?.length ? <span className={s.dim}> · {spec.tools.length}</span> : null}</p>
      {spec.tools?.length ? spec.tools.map((t) => (
        <details key={t.name} className={s.block}>
          <summary><code>{t.name}</code>{t.description ? <span className={s.dim}> · {t.description}</span> : null}</summary>
          <p className={`sc ${s.stepsLabel}`}>input_schema</p>
          <JsonTree value={t.input_schema} open />
        </details>
      )) : <p className={s.dim}>none</p>}
    </div>
  );
}

function ToolDef({ name, tools }: { name: string; tools: ReplayToolDef[] }) {
  const [open, setOpen] = useState(false);
  const def = tools.find((t) => t.name === name);
  return (
    <div className={s.toolDef}>
      <button type="button" className={s.linklike} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "hide" : "show"} the definition of <code>{name}</code>
      </button>
      {open ? (
        def ? (
          <div className={s.block}>
            {def.description ? <p className={s.deltaProse}>{def.description}</p> : null}
            <JsonTree value={def.input_schema} open />
          </div>
        ) : <p className={s.dim}>This event&rsquo;s prompt step does not list <code>{name}</code>; open the prompt step for the tools it was given.</p>
      ) : null}
    </div>
  );
}

/** A prompt's full text, reached from the episode overview: the prompt step of the event that carried it. */
export function PromptDrawer({ replayName, arm, event, agent }: { replayName: string; arm: ReplayArm; event: ReplayEvent; agent: string }) {
  const detail = useEventDetail(replayName, arm.key, event, true);
  const steps = detail.status === "ready" ? detail.detail.steps : event.steps;
  const step = steps.find((x) => x.kind === "prompt");
  const spec = step ? promptSpecOf(step) : null;
  const meta = agentMeta(agent);
  return (
    <div>
      <p className={s.nowMeta}>
        The {meta.label}&rsquo;s system prompt as sent in event #{event.seq} of {arm.label}.
        {meta.docs ? <> Compare the vendored prompt page: <a href={`/docs/agents/${meta.docs}`}>/docs/agents/{meta.docs}</a>.</> : null}
      </p>
      {detail.status === "loading" ? <p className={s.dim}>Loading…</p> : null}
      {detail.status === "missing" ? <p className={s.dim}>No detail file was vendored for this event, so the text is not available here.</p> : null}
      {detail.status === "error" ? <p className={s.dim}>Could not load the detail file ({detail.message}).</p> : null}
      {detail.status === "ready" && !step ? <p className={s.dim}>The detail file has no prompt step.</p> : null}
      {spec ? <pre className={s.verbatim}>{promptText(spec.system)}</pre> : null}
    </div>
  );
}
