/**
 * The site's pages for a mandate and its granting conversation, as the reads
 * of both hand them to callers. A claim read carries its page_url; a mandate
 * read carries its own the same way, so an agent never has to guess a path
 * or read the site guide to link its user to what they funded.
 *
 *   page_url    the mandate's public page (/mandates/:id), which everyone
 *               reads and where its manager also sees what waits on them.
 *   funder_url  the manager's own page for it (/ask/mandates/:id): the
 *               conversation with its Grantmaker beside the mandate at a
 *               glance, with approve, top up and withdraw. Given only to the
 *               funder.
 *   conversation_url  a granting conversation not yet funded
 *               (/ask/mandates/c/:id), where the draft is read and funded.
 *
 * The base is the same knob claim links use (PUBLIC_WEB_BASE_URL).
 */
import { loadConfig } from "../config.js";

function base(): string {
  return loadConfig().publicWebBaseUrl.replace(/\/$/, "");
}

export function mandatePageUrl(mandateId: string): string {
  return `${base()}/mandates/${mandateId}`;
}

export function mandateFunderUrl(mandateId: string): string {
  return `${base()}/ask/mandates/${mandateId}`;
}

export function grantConversationUrl(conversationId: string): string {
  return `${base()}/ask/mandates/c/${conversationId}`;
}
