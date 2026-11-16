"use client";

import { useMemo, useState } from "react";
import type { SourcePage } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { SourceHead } from "./SourceHead";
import { Examinations } from "./Examinations";
import { AnnotatedText } from "./AnnotatedText";
import { SourceRecord } from "./SourceRecord";
import { OutlineRail } from "./OutlineRail";
import { Lineage } from "./Lineage";
import { History } from "./History";
import { absentLine, claimNames, examViews, findingsBySegment, groupsOf, sourceShape } from "./model";
import s from "./source.module.css";

// The source page (#507). No verdict on the source and no score anywhere:
// the facts, the document in its own order with each claim's reading where
// that claim touches it, and the examinations, each scoped and attributed.
// The one piece of state is which examination is laid over the text. A
// section shows only when it has something in it; what a quiet page leaves
// out is said once, under the text, instead of as a row of empty sections.
export function SourceView({ page, source }: { page: SourcePage; source: DataSource }) {
  const groups = useMemo(() => groupsOf(page.document), [page.document]);
  const exams = useMemo(() => examViews(page), [page]);
  const findings = useMemo(() => findingsBySegment(exams), [exams]);
  const names = useMemo(() => claimNames(page), [page]);
  const findingSegs = useMemo(() => new Set(findings.keys()), [findings]);
  const shape = useMemo(() => sourceShape(page, groups, findingSegs), [page, groups, findingSegs]);
  const absent = absentLine(page, shape);
  const [shown, setShown] = useState<string | null>(null);
  const toggle = (id: string) => setShown((cur) => (cur === id ? null : id));

  return (
    <div className={s.bleed}>
      <div className={`${s.grid} ${shape.busy ? "" : s.norail}`}>
        {shape.busy && <OutlineRail groups={groups} exams={exams} findings={findingSegs} />}
        <div className={s.main}>
          <SourceHead page={page} groups={groups} exams={exams} busy={shape.busy} sample={source === "fixture"} />
          {shape.examined > 0 && <Examinations
            exams={exams}
            groups={groups}
            segmented={!!page.document?.segmented}
            names={names}
            shown={shown}
            context={page.context}
            onShow={(id) => {
              toggle(id);
              if (shown !== id) document.getElementById("text")?.scrollIntoView({ behavior: "smooth" });
            }}
          />}
          <AnnotatedText
            doc={page.document}
            groups={groups}
            exams={exams}
            findings={findings}
            names={names}
            shown={shown}
            setShown={setShown}
            map={exams.length > 0 || shape.touched >= 2}
          />
          {absent && <p className={s.absent}>{absent}</p>}
          {shape.lineage > 0 && <Lineage context={page.context} title={page.facts.source.title} />}
          <SourceRecord page={page} groups={groups} intakeOnly={shape.history === 0} />
          {shape.history > 0 && <History context={page.context} />}
        </div>
      </div>
    </div>
  );
}
