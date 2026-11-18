// What the sidebar shows beside its entries (components/work/Sidebar.tsx),
// as app/api/work/counts answers it. Kept apart so the client component can
// import the shape without the server code that computes it (lib/inbox.ts).

export interface WorkCounts {
  /** The organisation that runs the deployment, where it has been named. */
  deployment: string | null;
  inbox: number;
  review: number;
  public_requests: number;
  replies: number;
  /** null where the person cannot see it. */
  health: "ok" | "warn" | "bad" | null;
  connections: "ok" | "warn" | "bad" | null;
  /**
   * This deployment's connection to minerval.ai: bad where it is no longer
   * taken there, warn where it waits, was never made, or lacks a grant its
   * settings need. null where the person cannot see it. Absent from an older build.
   */
  public_graph?: "ok" | "warn" | "bad" | null;
  /** The mirror of the public graph: bad where it stopped at a refusal, warn where the feed's key waits or the feed was not read. */
  mirror?: "ok" | "warn" | "bad" | null;
}
