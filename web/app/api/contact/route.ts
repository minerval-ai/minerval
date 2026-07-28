import { NextRequest, NextResponse } from "next/server";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// Contact form delivery (issue #81): a route handler that forwards messages by
// email over SES. The destination and sender live in env, never in the client
// bundle; the page never shows a raw address. Spam protection is deliberately
// light per the issue: a honeypot field and a per-IP rate limit, no CAPTCHA.

export const runtime = "nodejs";

const MAX_MESSAGE = 5000;
const MAX_NAME = 200;
const MAX_EMAIL = 320;

// Per-IP rate limit: 3 messages per 10 minutes. In-memory, so it resets on
// redeploy and is per-instance on serverless — a speed bump, not a wall,
// which is all the issue asks for.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 3;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

export async function POST(request: NextRequest) {
  const to = process.env.CONTACT_TO_EMAIL;
  const from = process.env.CONTACT_FROM_EMAIL;
  if (!to || !from) {
    return NextResponse.json(
      { error: "The contact form is not configured on this deployment." },
      { status: 503 },
    );
  }

  let body: { name?: string; email?: string; message?: string; website?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: real users never see the "website" field. Pretend success so
  // bots learn nothing.
  if (body.website) {
    return NextResponse.json({ ok: true });
  }

  const name = (body.name ?? "").trim().slice(0, MAX_NAME);
  const email = (body.email ?? "").trim().slice(0, MAX_EMAIL);
  const message = (body.message ?? "").trim().slice(0, MAX_MESSAGE);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Please write a message." }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many messages in a short time. Please try again later." },
      { status: 429 },
    );
  }

  const ses = new SESv2Client({});
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: [email],
        Content: {
          Simple: {
            Subject: { Data: `[minerval.ai contact] ${name || email}` },
            Body: {
              Text: {
                Data: `From: ${name || "(no name)"} <${email}>\n\n${message}`,
              },
            },
          },
        },
      }),
    );
  } catch (err) {
    console.error("[minerval] contact send failed:", err);
    return NextResponse.json(
      { error: "The message could not be sent. Please try again later." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
