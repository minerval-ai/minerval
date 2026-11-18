import type { ReactNode } from "react";
import type { WorkIcon } from "../../lib/work-sections";

// The workspace's icons: stroke drawings at 24 units, drawn in the text's
// colour. Each is decoration beside a word, so each is hidden from a screen
// reader.

const PATHS: Record<WorkIcon | "plus" | "lock" | "warn" | "search" | "close" | "chevron" | "check" | "money" | "file" | "external" | "copy", ReactNode> = {
  inbox: (<><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>),
  review: (<><path d="M9 11l3 3 8-8" /><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11" /></>),
  ask: <path d="M4 5h16v11H9l-5 4z" />,
  claims: (<><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7.5 7.5 11 16.5M16.5 7.5 13 16.5" /></>),
  mandates: (<><path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6" /></>),
  findings: <path d="M12 3 4 7v6c0 4 3.5 7 8 8 4.5-1 8-4 8-8V7z" />,
  requests: (<><circle cx="12" cy="12" r="8" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01" /></>),
  docs: (<><path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2z" /><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2z" /></>),
  releases: (<><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>),
  boundaries: (<><path d="M12 3v18" /><path d="M4 8h5M4 16h5M15 8h5M15 16h5" /></>),
  sources: (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>),
  "file-sets": <path d="M3 7h6l2 2h10v10H3z" />,
  connections: (<><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></>),
  globe: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>),
  "public-requests": (<><path d="M4 4h16v12H8l-4 4z" /><path d="M12 8v3M12 13.5h.01" /></>),
  replies: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 5 5v6" /></>),
  outbox: (<><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></>),
  health: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  people: (<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.6 2.6 3 5.2" /></>),
  labels: (<><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.5" /></>),
  parties: (<><path d="M4 21V8l8-5 8 5v13" /><path d="M9 21v-6h6v6" /></>),
  budget: (<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>),
  log: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  warn: (<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="M5 12l5 5L20 7" />,
  money: (<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /></>),
  file: (<><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /></>),
  external: (<><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
  copy: (<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
