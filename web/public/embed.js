/*! Minerval claim embeds. https://minerval.ai */
// Turns each
//   <blockquote class="minerval-claim" data-claim-id="ID">
//     <a href="https://minerval.ai/claims/ID">the claim</a>
//   </blockquote>
// into the claim's card: an iframe of /embed/claims/ID, kept as tall as its
// content. Until this runs, or if it never does, the quotation and its link
// stay as they are. Optional data-theme="light" or "dark" fixes the card's
// colours; otherwise it follows the reader's colour scheme.
//
// Plain script, no dependencies, no build step. Safe to include more than
// once. Blockquotes added after it has run: call MinervalEmbed.scan().
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var api = window.MinervalEmbed;
  if (api && typeof api.scan === "function") {
    // A second copy on the page: one listener is enough; pick up anything new.
    api.scan();
    return;
  }

  // The site this script was served from is the site the cards come from.
  var origin = "https://minerval.ai";
  try {
    if (document.currentScript && document.currentScript.src) {
      origin = new URL(document.currentScript.src, document.baseURI).origin;
    }
  } catch (e) {}

  var MESSAGE = "minerval:embed:height";
  var ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  var frames = [];

  function claimId(el) {
    var id = el.getAttribute("data-claim-id");
    if (id && ID.test(id)) return id;
    var links = el.getElementsByTagName("a");
    for (var i = 0; i < links.length; i++) {
      try {
        var m = /^\/claims\/([^\/]+)\/?$/.exec(new URL(links[i].href, document.baseURI).pathname);
        if (m && ID.test(decodeURIComponent(m[1]))) return decodeURIComponent(m[1]);
      } catch (e) {}
    }
    return null;
  }

  function mount(el) {
    var id = claimId(el);
    if (!id || !el.parentNode) return;
    var theme = el.getAttribute("data-theme");
    var text = (el.textContent || "").replace(/\s+/g, " ").trim();
    var frame = document.createElement("iframe");
    frame.src = origin + "/embed/claims/" + encodeURIComponent(id) +
      (theme === "light" || theme === "dark" ? "?theme=" + theme : "");
    frame.title = "Minerval: " + (text.length > 90 ? text.slice(0, 89) + "…" : text || "claim");
    frame.setAttribute("data-minerval-claim", id);
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("allowtransparency", "true");
    frame.style.cssText =
      "display:block;width:100%;max-width:560px;height:190px;margin:1em 0;border:0;overflow:hidden;background:transparent";
    frames.push(frame);
    el.parentNode.replaceChild(frame, el);
  }

  function scan(root) {
    var found = (root || document).querySelectorAll("blockquote.minerval-claim");
    // A static copy: mounting removes each element from the live document.
    var list = Array.prototype.slice.call(found);
    for (var i = 0; i < list.length; i++) mount(list[i]);
  }

  // The card says how tall it is; believe only a card this script placed,
  // speaking from the site it was loaded from.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.origin !== origin || !data || data.type !== MESSAGE) return;
    var height = Number(data.height);
    if (!(height > 0) || height > 4000) return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) {
        if (frames[i].getAttribute("data-minerval-claim") === data.id) {
          frames[i].style.height = Math.ceil(height) + "px";
        }
        return;
      }
    }
  });

  window.MinervalEmbed = { scan: scan };

  scan();
  // Loaded from the head, or async before the page finished parsing: look
  // again once the document is whole.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { scan(); });
  }
})();
