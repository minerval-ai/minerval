import type {
  AssessmentStatus,
  DocumentInstance,
  DocumentSegment,
  Examination,
  InstanceSupport,
  SourceDocument,
  SourceContext,
  SourcePage,
  SourceSegmentKind,
} from "./types";

// Sample source pages for the offline preview (#507): a corrected paper with
// two examinations, a think-tank report with copies and a later edition but no
// examination, and a transcript with almost nothing recorded. Invented
// examples, written so each state of the page has something to show.

type Leaf = {
  id: string;
  kind: Exclude<SourceSegmentKind, "section">;
  label?: string;
  text: string;
  instances?: DocumentInstance[];
};
type Section = { id: string; section: string; children: Array<Section | Leaf> };

// Lays a nested outline out as segments with offsets into one readable text,
// blocks separated by blank lines as the segmenter reads them.
function buildDocument(sourceId: string, outline: Array<Section | Leaf>, unanchored: DocumentInstance[] = []): SourceDocument {
  const segments: DocumentSegment[] = [];
  let at = 0;
  const walk = (nodes: Array<Section | Leaf>, parent: string | null) => {
    for (const n of nodes) {
      if ("section" in n) {
        const start = at;
        at += n.section.length + 2;
        const seg: DocumentSegment = {
          id: n.id, parent_id: parent, ordinal: segments.length, kind: "section", label: n.section,
          char_start: start, char_end: start, text: null, instances: [],
        };
        segments.push(seg);
        walk(n.children, n.id);
        seg.char_end = at - 2;
      } else {
        segments.push({
          id: n.id, parent_id: parent, ordinal: segments.length, kind: n.kind, label: n.label ?? null,
          char_start: at, char_end: at + n.text.length, text: n.text, instances: n.instances ?? [],
        });
        at += n.text.length + 2;
      }
    }
  };
  walk(outline, null);
  return { source_id: sourceId, segmented: segments.length > 0, total_chars: Math.max(0, at - 2), segments, unanchored };
}

let instanceSeq = 0;
function inst(
  claim: { id: string; text: string; status: AssessmentStatus | null },
  verbatim: string,
  reading: { support: InstanceSupport; note: string | null; source_read?: boolean } | null,
  stance: "affirms" | "denies" = "affirms",
): DocumentInstance {
  instanceSeq += 1;
  return {
    instance_id: `inst-${instanceSeq}`,
    claim,
    stance,
    verbatim_text: verbatim,
    reading: reading ? { support: reading.support, note: reading.note, source_read: reading.source_read ?? true } : null,
  };
}

// --- a corrected paper, examined twice ----------------------------------------

const NIGHT = {
  id: "night-shift-raises-t2d-risk",
  text: "Regular night-shift work raises the risk of type 2 diabetes.",
  status: "supported" as const,
};
const COHORT = {
  id: "cohort-2016-higher-incidence",
  text: "A 2016 cohort study of nurses found a higher incidence of type 2 diabetes among those working rotating night shifts.",
  status: "verified" as const,
};
const HR = {
  id: "night-shift-hr-1-3",
  text: "Five or more years of night-shift work is associated with roughly a 30% higher incidence of type 2 diabetes.",
  status: "verified" as const,
};
const BMI = {
  id: "night-shift-t2d-persists-after-bmi",
  text: "The association between night-shift work and type 2 diabetes persists after adjusting for body mass index.",
  status: "supported" as const,
};
const DOUBLES = {
  id: "night-shift-doubles-t2d-risk",
  text: "Night-shift work doubles the risk of type 2 diabetes.",
  status: "contradicted" as const,
};
const FIFTH = {
  id: "quarter-of-workers-work-nights",
  text: "One in four workers in the region works night shifts.",
  status: "contested" as const,
};

function registryStudy(): SourcePage {
  const id = "registry-study";
  const document = buildDocument(id, [
    { id: "rs-abs", section: "Abstract", children: [
      { id: "rs-abs-1", kind: "passage", text: "Night-shift work raises the risk of type 2 diabetes. In a national registry of 412,000 workers followed for a median of 9.4 years, long-term night-shift work was associated with a 31% higher incidence of type 2 diabetes after adjustment for age, sex and body mass index.",
        instances: [inst(NIGHT, "Night-shift work raises the risk of type 2 diabetes.", { support: "overstates", note: "Its own registry data bear an association, drawn independently of the 2016 cohort. The abstract's \"raises\" is causal; the design is observational and the results say \"associated with\"." })] },
      { id: "rs-abs-2", kind: "passage", text: "We linked a national shift registry to prescription and hospital records, and estimated hazard ratios by years of night work." },
    ] },
    { id: "rs-intro", section: "1 Introduction", children: [
      { id: "rs-i-1", kind: "passage", text: "Shift work is common in health care, transport and manufacturing, and a substantial share of the region's workforce works at least some nights." },
      { id: "rs-i-2", kind: "passage", text: "A 2016 cohort study of nurses reported a higher incidence of type 2 diabetes among those who worked rotating night shifts [4].",
        instances: [inst(COHORT, "A 2016 cohort study of nurses reported a higher incidence of type 2 diabetes among those who worked rotating night shifts", { support: "supports", note: "Describes the cohort study as that study describes itself." })] },
      { id: "rs-i-3", kind: "passage", text: "Registry data allow a larger population, drawn independently of the earlier cohorts, with exposure recorded by employers rather than recalled by participants." },
    ] },
    { id: "rs-meth", section: "2 Methods", children: [
      { id: "rs-m-21", section: "2.1 Exposure", children: [
        { id: "rs-m-1", kind: "passage", text: "Shift status was taken from employer registry records at entry to the registry. Night work was defined as at least three shifts a month including the hours between midnight and 5 a.m." },
      ] },
      { id: "rs-m-22", section: "2.2 Outcome", children: [
        { id: "rs-m-2", kind: "passage", text: "Incident type 2 diabetes was defined by a first prescription of a glucose-lowering drug or a first hospital diagnosis, whichever came first." },
      ] },
      { id: "rs-m-23", section: "2.3 Analysis", children: [
        { id: "rs-m-3", kind: "passage", text: "Cox models were adjusted for age, sex and body mass index; a second model added education and household income." },
        { id: "rs-m-4", kind: "note", label: "Data availability", text: "Registry data are available to accredited researchers under a data-access agreement with the registry holder." },
      ] },
    ] },
    { id: "rs-res", section: "3 Results", children: [
      { id: "rs-r-1", kind: "passage", label: "3.1", text: "Long-term night-shift work (five or more years) was associated with a higher incidence of type 2 diabetes (hazard ratio 1.31, 95% CI 1.22 to 1.41).",
        instances: [
          inst(NIGHT, "Long-term night-shift work (five or more years) was associated with a higher incidence of type 2 diabetes", { support: "supports", note: "The registry estimate itself. Observational, and says so." }),
          inst(HR, "hazard ratio 1.31, 95% CI 1.22 to 1.41", { support: "supports", note: "The figure as the paper reports it; Table 2 agrees." }),
        ] },
      { id: "rs-r-2", kind: "passage", label: "3.2", text: "The association was stronger with more years of night work, with no threshold below five years." },
      { id: "rs-r-3", kind: "passage", label: "3.3", text: "Results were similar for men and women, and in the model adding education and household income." },
      { id: "rs-r-4", kind: "passage", label: "3.4", text: "The association persisted after further adjustment for body mass index (Table 3).",
        instances: [inst(BMI, "The association persisted after further adjustment for body mass index", { support: "unclear", note: "Reopened after the correction of Table 3; reassessment queued. The sentence is unchanged; the table it rests on changed." })] },
      { id: "rs-r-t3", kind: "table", label: "Table 3", text: "BMI group | Night workers | Hazard ratio (95% CI)\nUnder 25 | 61,204 | 1.24 (1.09 to 1.41)\n25 to 30 | 58,877 | 1.29 (1.16 to 1.44)\n30 or over | 31,560 | 1.18 (1.02 to 1.37)" },
    ] },
    { id: "rs-disc", section: "4 Discussion", children: [
      { id: "rs-d-1", kind: "passage", text: "Circadian disruption, shortened sleep and changes in meal timing are the proposed mechanisms; this study cannot separate them." },
      { id: "rs-d-2", kind: "passage", text: "Our estimates are close to those of earlier cohorts. We find no support for the figure, repeated in press coverage of earlier work, that night work doubles the risk.",
        instances: [inst(DOUBLES, "We find no support for the figure, repeated in press coverage of earlier work, that night work doubles the risk.", { support: "supports", note: "The paper's own estimate, 1.31, is well short of a doubling, and it says so directly." }, "denies")] },
      { id: "rs-d-3", kind: "passage", text: "Employers in the registry are larger than average, which may limit how far the estimates carry to small firms." },
    ] },
    { id: "rs-lim", section: "5 Limitations", children: [
      { id: "rs-l-1", kind: "passage", text: "Shift status was recorded at entry only; later changes of schedule are not captured." },
      { id: "rs-l-2", kind: "passage", text: "Residual confounding by socioeconomic position cannot be excluded." },
    ] },
    { id: "rs-refs", section: "References", children: [
      { id: "rs-ref-1", kind: "reference", label: "1", text: "Occupational Survey Office. Working time in the region, 2019. Statistical bulletin." },
      { id: "rs-ref-2", kind: "reference", label: "2", text: "Lindqvist A, Moreau P. Circadian rhythm and glucose metabolism: a review. Example Reviews in Endocrinology. 2018." },
      { id: "rs-ref-3", kind: "reference", label: "3", text: "Okafor N et al. Sleep duration and incident diabetes. Example Journal of Sleep Research. 2017." },
      { id: "rs-ref-4", kind: "reference", label: "4", text: "Hale J, Duarte M et al. Rotating night shifts and type 2 diabetes in a cohort of nurses. Example Medical Journal. 2016." },
      { id: "rs-ref-5", kind: "reference", label: "5", text: "Registry Holder. Shift registry: data dictionary, version 3. 2020." },
      { id: "rs-ref-6", kind: "reference", label: "6", text: "Brandt K. Meal timing in shift workers. Example Nutrition Letters. 2015." },
      { id: "rs-ref-7", kind: "reference", label: "7", text: "Hale J et al. Night shifts and diabetes: a reanalysis of the nurses' cohort. Example Medical Journal. 2019." },
      { id: "rs-ref-8", kind: "reference", label: "8", text: "Sato Y. Measurement of shift exposure in registries. Example Methods in Epidemiology. 2021." },
    ] },
  ], [inst(FIFTH, "one in four workers in the region works nights", { support: "unclear", note: "The quoted figure is not in the stored text; the introduction says only \"a substantial share\".", source_read: true })]);

  const examinations: Examination[] = [
    {
      id: "ex-rs-claim",
      scope: "claim",
      trigger: "claim",
      claim: { id: NIGHT.id, text: NIGHT.text },
      grant_id: null,
      source_id: id,
      brief: "Establish whether this study's data are independent of the 2016 cohort study, what its design can show, and whether its tables can be recomputed.",
      facets: ["basis", "assertions", "citations", "recomputation", "limits"],
      requested_by: "claim_steward",
      created_at: "2025-11-04T10:12:00Z",
      runs: [{ id: "run-rs-1", status: "completed", model: "claude-opus-5-5", spent_usd: 2.8, finished_at: "2025-11-04T11:40:00Z" }],
      coverage: [
        { segment_id: "rs-abs", facet: "assertions" },
        { segment_id: "rs-m-21", facet: "basis" },
        { segment_id: "rs-m-4", facet: "recomputation" },
        { segment_id: "rs-r-1", facet: "assertions" },
        { segment_id: "rs-r-1", facet: "recomputation" },
        { segment_id: "rs-lim", facet: "limits" },
        { segment_id: "rs-ref-4", facet: "citations" },
        { segment_id: "rs-ref-7", facet: "citations" },
      ],
      findings: [
        { id: "f-rs-1", segment_id: "rs-abs-1", segment_label: null, facet: "assertions",
          statement: "The abstract says night-shift work \"raises\" the risk; the design is observational and the results say \"associated with\".",
          evidence: "Abstract, first sentence; Results 3.1. No instrument or natural experiment is described in Methods.",
          created_by: "researcher", created_at: "2025-11-04T11:20:00Z", audit_notes: [], cited_by_claims: [NIGHT.id] },
        { id: "f-rs-2", segment_id: "rs-m-1", segment_label: null, facet: "basis",
          statement: "Shift status comes from employer registry records, not self-report. No author or dataset is shared with the 2016 cohort study or its 2019 reanalysis.",
          evidence: "Methods 2.1; author lists of references 4 and 7; the registry data dictionary (reference 5).",
          created_by: "researcher", created_at: "2025-11-04T11:22:00Z", audit_notes: [], cited_by_claims: [NIGHT.id, HR.id] },
        { id: "f-rs-3", segment_id: "rs-m-4", segment_label: "Data availability", facet: "recomputation",
          statement: "Recomputation not attempted: the registry data are held under a data-access agreement. The published tables agree with each other.",
          evidence: "Data availability statement; row totals of Tables 1 to 3 checked against the cohort size.",
          created_by: "researcher", created_at: "2025-11-04T11:25:00Z", audit_notes: [], cited_by_claims: [] },
        { id: "f-rs-4", segment_id: "rs-l-1", segment_label: null, facet: "limits",
          statement: "Shift status is recorded at entry only, so workers who left night work are counted as exposed. The authors say so.",
          evidence: "Limitations, first paragraph; Methods 2.1.",
          created_by: "researcher", created_at: "2025-11-04T11:28:00Z", audit_notes: [], cited_by_claims: [NIGHT.id] },
        { id: "f-rs-5", segment_id: "rs-ref-4", segment_label: "4", facet: "citations",
          statement: "Reference 4, the 2016 cohort study, is described as it describes itself.",
          evidence: "Introduction, second paragraph, against the cohort study's abstract and Table 2.",
          created_by: "researcher", created_at: "2025-11-04T11:31:00Z", audit_notes: [], cited_by_claims: [COHORT.id] },
      ],
    },
    {
      id: "ex-rs-doc",
      scope: "document",
      trigger: "mandate",
      claim: null,
      grant_id: "grant-occupational-health",
      source_id: id,
      brief: "Review the paper for the occupational-health mandate: what its data are, what it asserts beyond them, and whether the correction of 12 August 2026 changes what Results 3.4 says.",
      facets: ["assertions", "tables"],
      requested_by: "grantmaker",
      created_at: "2026-08-20T09:00:00Z",
      runs: [{ id: "run-rs-2", status: "completed", model: "claude-opus-5-5", spent_usd: 1.1, finished_at: "2026-08-20T09:48:00Z" }],
      coverage: [
        { segment_id: "rs-abs", facet: "assertions" },
        { segment_id: "rs-res", facet: "assertions" },
        { segment_id: "rs-r-t3", facet: "tables" },
      ],
      findings: [
        { id: "f-rs-6", segment_id: "rs-r-t3", segment_label: "Table 3", facet: "tables",
          statement: "In the corrected Table 3, the hazard ratio for night workers with a BMI of 30 or over moves from 1.18 (1.02 to 1.37) to 1.06 (0.91 to 1.24). The other two rows are unchanged.",
          evidence: "Stored Table 3 against the correction notice of 12 August 2026.",
          created_by: "researcher", created_at: "2026-08-20T09:40:00Z",
          audit_notes: [{ note: "Compared the stored original with the correction notice: the replaced row is the one this finding names.", created_by: "audit_agent", created_at: "2026-08-22T14:05:00Z" }],
          cited_by_claims: [] },
        { id: "f-rs-7", segment_id: "rs-r-4", segment_label: "3.4", facet: "assertions",
          statement: "The sentence in Results 3.4 is unchanged by the correction; the table it rests on changed, and for the highest BMI group no longer shows an association.",
          evidence: "Results 3.4; Table 3 as corrected.",
          created_by: "researcher", created_at: "2026-08-20T09:44:00Z", audit_notes: [], cited_by_claims: [] },
        { id: "f-rs-8", segment_id: null, segment_label: null, facet: "assertions",
          statement: "The correction notice gives no reason for the recomputed row.",
          evidence: "Correction notice, 12 August 2026.",
          created_by: "researcher", created_at: "2026-08-20T09:46:00Z", audit_notes: [], cited_by_claims: [] },
      ],
    },
  ];

  return {
    facts: {
      source: {
        id,
        url: "https://example.org/ejoh/2022/0412",
        title: "Night-shift work and incident type 2 diabetes in a national shift registry",
        source_type: "journal_article",
        authors: ["Registry Study Group"],
        publisher: "Example Journal of Occupational Health",
        published_date: "2022-03",
        doi: "10.5555/ejoh.2022.0412",
        archived_url: "https://web.archive.org/web/2023/https://example.org/ejoh/2022/0412",
        retrieved_at: "2023-01-03T08:00:00Z",
        facts_checked_at: "2026-08-13T06:00:00Z",
      },
      versions: [{ id: "registry-study-preprint", title: "Night-shift work and type 2 diabetes: a registry study (preprint)", url: "https://example.org/preprints/2021.03.118", later: false }],
      copies: [],
      copy_of: [],
      events: [{
        kind: "correction",
        occurred_at: "2026-08-12",
        detected_at: "2026-08-13T06:00:00Z",
        notice_url: "https://example.org/ejoh/2026/corr-0412",
        note: "Table 3 replaced: the row for a body mass index of 30 or over was recomputed.",
        detected_by: "correction_watcher",
      }],
    },
    document,
    examinations,
  };
}

// --- a think-tank report with copies and a later edition --------------------------

const PRODUCTIVITY = {
  id: "four-day-week-productivity-up",
  text: "Firms that moved to a four-day week kept or raised their productivity.",
  status: "contested" as const,
};
const RETENTION = {
  id: "four-day-week-staff-turnover",
  text: "Staff turnover fell in firms that adopted a four-day week.",
  status: "supported" as const,
};
const SIXTY_ONE = {
  id: "four-day-week-trial-61-firms",
  text: "The 2023 four-day week trial included 61 firms.",
  status: "verified" as const,
};
const ECONOMY = {
  id: "four-day-week-national-gdp",
  text: "A national four-day week would raise GDP.",
  status: "unsupported" as const,
};

function thinkTankReport(): SourcePage {
  const id = "think-tank-report";
  const document = buildDocument(id, [
    { id: "tt-sum", section: "Summary", children: [
      { id: "tt-s-1", kind: "passage", text: "In 2023, 61 firms trialled a four-day week with no loss of pay. Most kept it.",
        instances: [inst(SIXTY_ONE, "In 2023, 61 firms trialled a four-day week", { support: "supports", note: "Matches the trial organisers' published list." })] },
      { id: "tt-s-2", kind: "passage", text: "Productivity held or rose, staff turnover fell by more than half, and the case for a national four-day week is now overwhelming.",
        instances: [
          inst(PRODUCTIVITY, "Productivity held or rose", { support: "asserts_without_evidence", note: "The report measures no productivity; it reports managers' answers to a survey question about it." }),
          inst(RETENTION, "staff turnover fell by more than half", { support: "supports", note: "From firms' own HR records, reported in section 2.3 with the counts." }),
          inst(ECONOMY, "the case for a national four-day week is now overwhelming", { support: "overstates", note: "Argued from 61 volunteer firms; nothing in the report addresses an economy-wide change." }),
        ] },
    ] },
    { id: "tt-1", section: "1 The trial", children: [
      { id: "tt-1-1", kind: "passage", text: "Firms volunteered through an open call. Participants ranged from a 6-person design studio to a 900-person logistics firm." },
      { id: "tt-1-2", kind: "passage", text: "Each firm agreed its own plan for reducing hours; most chose a fixed day off, some a shorter working day." },
    ] },
    { id: "tt-2", section: "2 Findings", children: [
      { id: "tt-2-1", kind: "passage", label: "2.1", text: "Of the 61 firms, 54 continued the four-day week after the trial and 18 have made it permanent." },
      { id: "tt-2-2", kind: "passage", label: "2.2", text: "Asked whether productivity had changed, 46 managers said it had held steady and 9 said it had risen.",
        instances: [inst(PRODUCTIVITY, "46 managers said it had held steady and 9 said it had risen", { support: "understates", note: "What the survey bears is managers' perception; the report's own wording in 2.2 is careful, its summary is not." })] },
      { id: "tt-2-3", kind: "passage", label: "2.3", text: "Across firms reporting HR data, resignations fell from 248 in the six months before the trial to 109 during it.",
        instances: [inst(RETENTION, "resignations fell from 248 in the six months before the trial to 109 during it", { support: "supports", note: null })] },
      { id: "tt-2-t1", kind: "table", label: "Table 1", text: "Measure | Before | During\nResignations | 248 | 109\nSick days per employee | 4.1 | 2.9\nFirms reporting | 44 | 44" },
    ] },
    { id: "tt-3", section: "3 Method", children: [
      { id: "tt-3-1", kind: "passage", text: "Data come from a manager survey at the end of the trial and from HR records supplied voluntarily by 44 firms. There was no comparison group." },
    ] },
    { id: "tt-notes", section: "Notes", children: [
      { id: "tt-n-1", kind: "note", label: "1", text: "The trial was organised with the support of a campaign for shorter working hours." },
      { id: "tt-n-2", kind: "note", label: "2", text: "Firm-level data are not published." },
    ] },
  ]);

  return {
    facts: {
      source: {
        id,
        url: "https://example.org/working-futures/four-day-week-dividend",
        title: "The Four-Day Week Dividend: Results from 61 Firms",
        source_type: "report",
        authors: ["Mara Ellison", "Tom Adeyemi"],
        publisher: "Centre for Working Futures",
        published_date: "2024-06-11",
        doi: null,
        archived_url: "https://web.archive.org/web/2024/https://example.org/working-futures/four-day-week-dividend",
        retrieved_at: "2024-06-14T12:00:00Z",
        facts_checked_at: "2026-09-30T06:00:00Z",
      },
      versions: [{ id: "think-tank-report-2e", title: "The Four-Day Week Dividend, second edition", url: "https://example.org/working-futures/four-day-week-dividend-2e", later: true }],
      copies: [
        { id: "daily-ledger-four-day-week", title: "Four-day week \"a resounding success\", report finds (Daily Ledger)", url: "https://example.org/ledger/2024/06/four-day-week" },
        { id: "wire-four-day-week", title: "Firms stick with four-day week after trial (wire copy)", url: null },
      ],
      copy_of: [],
      events: [],
    },
    document,
    examinations: [],
  };
}

// --- a transcript with almost nothing recorded ----------------------------------

function councilTranscript(): SourcePage {
  const id = "council-transcript";
  return {
    facts: {
      source: {
        id,
        url: "https://example.org/council/meetings/2024-03-14",
        title: "Council meeting, 14 March 2024",
        source_type: "transcript",
        authors: [],
        publisher: null,
        published_date: "2024-03",
        doi: null,
        archived_url: null,
        retrieved_at: "2024-05-24T09:00:00Z",
        facts_checked_at: null,
      },
      versions: [],
      copies: [],
      copy_of: [],
      events: [],
    },
    document: {
      source_id: id,
      segmented: false,
      total_chars: 0,
      segments: [],
      unanchored: [inst(
        { id: "half-new-jobs-part-time", text: "Half of all new jobs created in the city since 2020 are part-time.", status: "contested" },
        "half of the new jobs in this city since 2020 have been part-time",
        { support: "unclear", note: "Judged from the extracted passage alone; the transcript was not stored.", source_read: false },
      )],
    },
    examinations: [],
  };
}

// --- context: lineage, prominence, history ------------------------------------------

const src = (id: string, title: string, source_type: string, published_date: string | null) =>
  ({ id, title, url: null, source_type, published_date });

function registryContext(): SourceContext {
  return {
    lineage: {
      draws_on: {
        total: 3,
        entries: [
          { source: src("cohort-2016", "Rotating night shifts and type 2 diabetes in a cohort of nurses", "journal_article", "2016"),
            relations: [{ relation_type: "cites_as_evidence", fidelity: "faithful", claims: 2 }], claims: 2, diverges: false },
          { source: src("cohort-2019-reanalysis", "Night shifts and diabetes: a reanalysis of the nurses' cohort", "journal_article", "2019"),
            relations: [{ relation_type: "cites_as_evidence", fidelity: "faithful", claims: 1 }], claims: 1, diverges: false },
        ],
        rest: [{ source_type: "dataset", sources: 1, fidelity: { faithful: 1 } }],
      },
      drawn_on_by: {
        total: 7,
        entries: [
          { source: src("shift-meta-analysis-2023", "Shift work and type 2 diabetes: a meta-analysis of 14 studies", "journal_article", "2023-05"),
            relations: [{ relation_type: "cites_as_evidence", fidelity: "faithful", claims: 2 }], claims: 2, diverges: false },
          { source: src("news-night-shifts-double", "Night shifts double your diabetes risk, study finds", "news_article", "2023-03-14"),
            relations: [
              { relation_type: "repeats", fidelity: "distorted", claims: 1 },
              { relation_type: "cites_as_evidence", fidelity: "faithful", claims: 1 },
            ], claims: 2, diverges: true },
          { source: src("commentary-2024", "Shift work and diabetes: what the registry studies can and cannot show", "commentary", "2024-01"),
            relations: [{ relation_type: "responds_to", fidelity: "faithful", claims: 1 }], claims: 1, diverges: false },
        ],
        rest: [
          { source_type: "news_article", sources: 3, fidelity: { faithful: 1, strengthened: 2 } },
          { source_type: "blog_post", sources: 1, fidelity: { unclear: 1 } },
        ],
      },
    },
    prominence: {
      reach: { copies: 0, direct_copies: 0 },
      structure: { claims: 6, origin_on: 3, origin_by_steward: 1, underlying_on: 1, downstream: 11, claims_read: 6 },
      evidence: {
        readings_by_support: { supports: 4, overstates: 1, unclear: 2 },
        read_whole: 7,
        claims_citing_findings: 3,
        notes: [
          { claim: { id: BMI.id, text: BMI.text }, support: "unclear", note: "Reopened after the correction of Table 3; reassessment queued. The sentence is unchanged; the table it rests on changed.", read_at: "2026-08-14T09:00:00Z" },
          { claim: { id: NIGHT.id, text: NIGHT.text }, support: "overstates", note: "Its own registry data bear an association, drawn independently of the 2016 cohort. The abstract's \"raises\" is causal; the design is observational.", read_at: "2025-12-04T10:00:00Z" },
          { claim: { id: DOUBLES.id, text: DOUBLES.text }, support: "supports", note: "The paper's own estimate, 1.31, is well short of a doubling, and it says so directly.", read_at: "2025-03-18T10:00:00Z" },
        ],
      },
    },
    history: [
      { at: "2026-09-30T04:00:00Z", kind: "watch", by: "correction_watcher", text: "Watched by DOI; 1 notice on record", claim: null },
      { at: "2026-08-22T14:05:00Z", kind: "audit_note", by: "audit_agent", text: "Note on a finding: In the corrected Table 3, the hazard ratio for night workers with a BMI of 30 or over moves…", claim: null },
      { at: "2026-08-20T09:46:00Z", kind: "finding", by: "researcher", text: "3 findings recorded", claim: null },
      { at: "2026-08-20T09:00:00Z", kind: "examination", by: "grantmaker", text: "Document review · assertions, tables · $1.10", claim: null },
      { at: "2026-08-14T09:00:00Z", kind: "reading", by: "claim_steward", text: "unclear, read whole", claim: { id: BMI.id, text: BMI.text } },
      { at: "2026-08-13T06:00:00Z", kind: "event", by: "correction_watcher", text: "correction: Table 3 replaced: the row for a body mass index of 30 or over was recomputed.", claim: null },
      { at: "2026-08-13T06:00:00Z", kind: "facts", by: "facts_fetcher", text: "Facts looked up", claim: null },
      { at: "2025-12-04T10:00:00Z", kind: "citation", by: "claim_steward", text: "Reading cites 3 findings", claim: { id: NIGHT.id, text: NIGHT.text } },
      { at: "2025-11-04T11:31:00Z", kind: "finding", by: "researcher", text: "5 findings recorded", claim: null },
      { at: "2025-11-04T10:12:00Z", kind: "examination", by: "claim_steward", text: "Examination commissioned · basis, assertions, citations, recomputation, limits · $2.80", claim: { id: NIGHT.id, text: NIGHT.text } },
      { at: "2025-03-18T10:00:00Z", kind: "reading", by: "claim_steward", text: "supports, read whole", claim: { id: DOUBLES.id, text: DOUBLES.text } },
      { at: "2025-03-18T09:40:00Z", kind: "reading", by: "claim_steward", text: "supports, read whole", claim: { id: COHORT.id, text: COHORT.text } },
      { at: "2023-01-03T08:05:00Z", kind: "segmented", by: "segmenter", text: "Divided into 38 parts by its own structure", claim: null },
      { at: "2023-01-03T08:00:00Z", kind: "retrieved", by: "graph", text: "Entered the graph; copy stored", claim: null },
    ],
  };
}

function thinkTankContext(): SourceContext {
  return {
    lineage: {
      draws_on: {
        total: 1,
        entries: [
          { source: src("four-day-week-firm-list", "Four-day week trial: participating firms", "dataset", "2023-02"),
            relations: [{ relation_type: "derives_from", fidelity: "faithful", claims: 1 }], claims: 1, diverges: false },
        ],
        rest: [],
      },
      drawn_on_by: {
        total: 26,
        entries: [
          { source: src("daily-ledger-four-day-week", "Four-day week \"a resounding success\", report finds", "news_article", "2024-06-12"),
            relations: [
              { relation_type: "republishes", fidelity: "faithful", claims: 2 },
              { relation_type: "repeats", fidelity: "strengthened", claims: 1 },
            ], claims: 3, diverges: true },
          { source: src("parliament-briefing-hours", "Working hours: a briefing for members", "report", "2024-11"),
            relations: [{ relation_type: "cites_as_evidence", fidelity: "faithful", claims: 2 }], claims: 2, diverges: false },
          { source: src("factcheck-four-day-productivity", "Did productivity really rise in the four-day week trial?", "fact_check", "2024-07"),
            relations: [{ relation_type: "responds_to", fidelity: "faithful", claims: 1 }], claims: 1, diverges: false },
        ],
        rest: [
          { source_type: "news_article", sources: 14, fidelity: { faithful: 9, strengthened: 5 } },
          { source_type: "social_post", sources: 6, fidelity: { strengthened: 3, unclear: 3 } },
          { source_type: "fact_check", sources: 3, fidelity: { faithful: 3 } },
        ],
      },
    },
    prominence: {
      reach: { copies: 5, direct_copies: 2 },
      structure: { claims: 4, origin_on: 3, origin_by_steward: 0, underlying_on: 0, downstream: 41, claims_read: 4 },
      evidence: {
        readings_by_support: { supports: 3, understates: 1, asserts_without_evidence: 1, overstates: 1 },
        read_whole: 6,
        claims_citing_findings: 0,
        notes: [
          { claim: { id: PRODUCTIVITY.id, text: PRODUCTIVITY.text }, support: "asserts_without_evidence", note: "The report measures no productivity; it reports managers' answers to a survey question about it.", read_at: "2025-02-10T10:00:00Z" },
          { claim: { id: ECONOMY.id, text: ECONOMY.text }, support: "overstates", note: "Argued from 61 volunteer firms; nothing in the report addresses an economy-wide change.", read_at: "2025-01-22T10:00:00Z" },
        ],
      },
    },
    history: [
      { at: "2026-09-30T06:00:00Z", kind: "facts", by: "facts_fetcher", text: "Facts looked up", claim: null },
      { at: "2025-02-10T10:00:00Z", kind: "reading", by: "claim_steward", text: "asserts without evidence, read whole", claim: { id: PRODUCTIVITY.id, text: PRODUCTIVITY.text } },
      { at: "2025-01-22T10:00:00Z", kind: "reading", by: "claim_steward", text: "overstates, read whole", claim: { id: ECONOMY.id, text: ECONOMY.text } },
      { at: "2024-09-02T10:00:00Z", kind: "reading", by: "claim_steward", text: "supports, read whole", claim: { id: RETENTION.id, text: RETENTION.text } },
      { at: "2024-08-30T10:00:00Z", kind: "reading", by: "claim_steward", text: "supports, read whole", claim: { id: SIXTY_ONE.id, text: SIXTY_ONE.text } },
      { at: "2024-06-14T12:05:00Z", kind: "segmented", by: "segmenter", text: "Divided into 17 parts by its own structure", claim: null },
      { at: "2024-06-14T12:00:00Z", kind: "retrieved", by: "graph", text: "Entered the graph; copy stored", claim: null },
    ],
  };
}

function councilContext(): SourceContext {
  const empty = { total: 0, entries: [], rest: [] };
  return {
    lineage: { draws_on: empty, drawn_on_by: empty },
    prominence: {
      reach: { copies: 0, direct_copies: 0 },
      structure: { claims: 1, origin_on: 0, origin_by_steward: 0, underlying_on: 0, downstream: 0, claims_read: 1 },
      evidence: {
        readings_by_support: { unclear: 1 },
        read_whole: 0,
        claims_citing_findings: 0,
        notes: [{ claim: { id: "half-new-jobs-part-time", text: "Half of all new jobs created in the city since 2020 are part-time." }, support: "unclear", note: "Judged from the extracted passage alone; the transcript was not stored.", read_at: "2025-01-12T10:00:00Z" }],
      },
    },
    history: [
      { at: "2025-01-12T10:00:00Z", kind: "reading", by: "claim_steward", text: "unclear, from the excerpt", claim: { id: "half-new-jobs-part-time", text: "Half of all new jobs created in the city since 2020 are part-time." } },
      { at: "2024-05-24T09:00:00Z", kind: "retrieved", by: "graph", text: "Entered the graph; no copy stored", claim: null },
    ],
  };
}

export function getSourcePageFixture(id: string): SourcePage | null {
  instanceSeq = 0;
  switch (id) {
    case "registry-study": return { ...registryStudy(), context: registryContext() };
    case "think-tank-report": return { ...thinkTankReport(), context: thinkTankContext() };
    case "council-transcript": return { ...councilTranscript(), context: councilContext() };
    default: return null;
  }
}

/** The sample ids, for the not-found page of the offline preview. */
export const SOURCE_FIXTURE_IDS = ["registry-study", "think-tank-report", "council-transcript"] as const;
