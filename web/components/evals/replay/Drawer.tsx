"use client";

import { useEffect, useRef, type ReactNode } from "react";
import s from "./replay.module.css";

// The drill-down surface: a side panel on wide screens, a bottom sheet on a
// phone, with a breadcrumb trail (Episode › Arm › Event › Step) whose every
// crumb is a link back up. Escape closes it.

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function Drawer({ crumbs, title, onClose, children }: { crumbs: Crumb[]; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <aside className={s.drawer} ref={ref} tabIndex={-1} role="dialog" aria-label={title}>
      <div className={s.drawerHead}>
        <nav className={s.crumbs} aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 ? <span className={s.crumbSep}>›</span> : null}
              {c.onClick ? <button type="button" className={s.crumb} onClick={c.onClick}>{c.label}</button> : <span className={`${s.crumb} ${s.crumbHere}`}>{c.label}</span>}
            </span>
          ))}
        </nav>
        <button type="button" className={s.close} onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      </div>
      <h3 className={s.drawerTitle}>{title}</h3>
      <div className={s.drawerBody}>{children}</div>
    </aside>
  );
}
