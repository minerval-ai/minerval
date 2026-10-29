import { defineContentScript } from "wxt/utils/define-content-script";
import { startOverlay } from "../contents/overlay";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main: startOverlay,
});
