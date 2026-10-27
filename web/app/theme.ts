// Light/dark theme. The page follows the system preference unless the reader
// has picked one with the masthead switch (components/ThemeToggle.tsx); the
// pick is kept in localStorage. Only a pick that differs from the system is
// stored, so switching back to the system's theme resumes following it.

export const THEME_KEY = "theme";

// Runs in <head> before first paint, so the page never flashes the wrong
// theme. Re-applies when the system preference changes, which only takes
// effect while no pick is stored.
export const THEME_SCRIPT = `(function(){try{
var m=window.matchMedia("(prefers-color-scheme: dark)");
var apply=function(){var t=null;try{t=localStorage.getItem("${THEME_KEY}")}catch(e){}
document.documentElement.setAttribute("data-theme",t==="light"||t==="dark"?t:(m.matches?"dark":"light"))};
apply();m.addEventListener("change",apply);
}catch(e){}})()`;
