"use client";

import { useMemo, useState } from "react";
import type { SourcePage } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { SourceHead } from "./SourceHead";
import { Examinations } from "./Examinations";
import { AnnotatedText } from "./AnnotatedText";
import { SourceRecord } from "./SourceRecord";
import { OutlineRail } from "./OutlineRail";
import { claimNames, examViews, findingsBySegment, groupsOf } from "./model";
import s from "./source.module.css";

// The source page (#507). No verdict on the source and no score anywhere:
// the facts, the document in its own order with each claim's reading where
// that claim touches it, and the examinations, each scoped and attributed.
// The one piece of state is which examination is laid over the text.
export function SourceView({ page, source }: { page: SourcePage; source: DataSource }) {
  const groups = useMemo(() => groupsOf(page.document), [page.document]);
  const exams = useMemo(() => examViews(page), [page]);
  const findings = useMemo(() => findingsBySegment(exams), [exams]);
  const names = useMemo(() => claimNames(page), [page]);
  const [shown, setShown] = useState<string | null>(null);
  const toggle = (id: string) => setShown((cur) => (cur === id ? null : id));

  return (
    <div className={s.bleed}>
      <div className={s.grid}>
        <OutlineRail groups={groups} exams={exams} />
        <div className={s.main}>
          <SourceHead page={page} groups={groups} exams={exams} sample={source === "fixture"} />
          <Examinations
            exams={exams}
            groups={groups}
            segmented={!!page.document?.segmented}
            names={names}
            shown={shown}
            onShow={(id) => {
              toggle(id);
              if (shown !== id) document.getElementById("text")?.scrollIntoView({ behavior: "smooth" });
            }}
          />
          <AnnotatedText
            doc={page.document}
            groups={groups}
            exams={exams}
            findings={findings}
            names={names}
            shown={shown}
            setShown={setShown}
          />
          <SourceRecord page={page} groups={groups} />
        </div>
      </div>
    </div>
  );
}
