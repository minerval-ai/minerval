import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

const icons = {
  16: "icon/16.png",
  32: "icon/32.png",
  48: "icon/48.png",
  64: "icon/64.png",
  128: "icon/128.png",
};

// Name, version, and description come from package.json.
export default defineConfig({
  srcDir: ".",
  outDir: "build",
  // Explicit imports from wxt/utils/* instead of generated globals.
  imports: false,
  alias: {
    "~lib": fileURLToPath(new URL("./lib", import.meta.url)),
  },
  manifest: {
    name: "Minerval",
    permissions: ["storage"],
    host_permissions: ["http://*/*", "https://*/*"],
    icons,
    action: { default_icon: icons },
  },
  // TSX through Vite's own Oxc transform; no React plugin needed.
  vite: () => ({ oxc: { jsx: { runtime: "automatic" } } }),
  zip: { artifactTemplate: "{{browser}}-{{manifestVersion}}-prod.zip" },
});
