import { useEffect, useState } from "react";
import Popup, { type View } from "./popup";

/**
 * The side panel: the popup's view in Chrome's side panel, which stays open
 * while the reader clicks and scrolls the page (a popup closes the moment it
 * loses focus). One panel per window, showing whichever tab is active: it
 * starts over on the new tab when the reader switches tabs, the tab moves to
 * another page, or the page finishes loading. Each tab's chat is kept in
 * session storage (lib/chat-store.ts), so switching back finds it again.
 */

// The view to open on, left by the popup's "open in side panel" button.
const VIEW_KEY = "panel-view";

export default function SidePanel() {
  const [view, setView] = useState<View>("page");
  // Changes whenever the panel should show a different tab or page.
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    void chrome.storage.session.get(VIEW_KEY).then((stored) => {
      const v = stored[VIEW_KEY] as View | undefined;
      if (v) {
        setView(v);
        void chrome.storage.session.remove(VIEW_KEY);
      }
    });
  }, []);

  useEffect(() => {
    let windowId: number | undefined;
    let activeId: number | undefined;
    let loads = 0;
    const show = (tab: chrome.tabs.Tab | undefined) => {
      activeId = tab?.id;
      setShown(`${tab?.id ?? "none"}|${tab?.url ?? ""}|${loads}`);
    };

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (info.windowId !== windowId) return;
      void chrome.tabs.get(info.tabId).then(show);
    };
    const onUpdated = (
      tabId: number,
      change: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tabId !== activeId) return;
      // A finished load means the page's content script can now answer.
      if (change.status === "complete") loads += 1;
      if (change.url || change.status === "complete") show(tab);
    };

    void chrome.windows.getCurrent().then(async (w) => {
      windowId = w.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      show(tab);
    });
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  if (shown === null) return <div className="popup panel" />;
  return <Popup key={shown} surface="panel" view={view} onView={setView} />;
}
