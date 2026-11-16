/**
 * What Audit's triage may find an agent's report to be about, in a
 * deployment that keeps its reports inside (report-sending-service.ts).
 * Only a report about Minerval's machinery is offered for sending to
 * Minerval's maintainers. Kept apart so that the tool which asks the
 * question imports nothing else.
 */
export const REPORT_ABOUT = {
  minerval: "Minerval's machinery: a tool, a prompt or a pipeline that every deployment runs",
  deployment: "this deployment: its setup, its data, its connections or its people",
} as const;
export type ReportAbout = keyof typeof REPORT_ABOUT;
