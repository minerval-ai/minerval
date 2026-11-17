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
}
