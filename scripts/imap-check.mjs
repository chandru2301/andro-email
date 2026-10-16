#!/usr/bin/env node
/**
 * IMAP credential check.
 *
 *   pnpm imap:check
 *
 * Verifies the credentials in .env.local without starting the app or writing
 * anything to the database. Prints the mailbox list and the newest few subjects
 * so you can confirm it is reading the right account.
 *
 * This never prints the password.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const user = (process.env.IMAP_USER ?? "").trim();
const pass = (process.env.IMAP_PASSWORD ?? "").replace(/\s+/g, "");

function fail(message, detail) {
  console.error(`\n  ✗ ${message}`);
  if (detail) console.error(`    ${detail}`);
  console.error();
  process.exit(1);
}

if (!user || !pass) {
  fail(
    "IMAP_USER and IMAP_PASSWORD are not both set.",
    "Fill them in .env.local, then run this again. If you just edited the file, make sure you are running with --env-file.",
  );
}

const host = (process.env.IMAP_HOST ?? "imap.gmail.com").trim();
const port = Number(process.env.IMAP_PORT ?? 993);
const secure = (process.env.IMAP_SECURE ?? "true") !== "false";
const mailbox = (process.env.IMAP_MAILBOX ?? "INBOX").trim();
const limit = Math.max(1, Math.min(500, Number(process.env.IMAP_LIMIT ?? 10)));

console.log(`\n  Connecting to ${host}:${port} as ${user} …`);

const client = new ImapFlow({
  host,
  port,
  secure,
  auth: { user, pass },
  logger: false,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
});

try {
  await client.connect();

  const boxes = await client.list();
  console.log(`  ✓ Connected. ${boxes.length} mailboxes visible.`);
  console.log(
    `    ${boxes
      .slice(0, 8)
      .map((b) => b.path)
      .join(", ")}${boxes.length > 8 ? ", …" : ""}`,
  );

  const lock = await client.getMailboxLock(mailbox);
  try {
    const exists = typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    console.log(`  ✓ ${mailbox} holds ${exists} message${exists === 1 ? "" : "s"}.`);

    if (exists === 0) {
      console.log("\n  Mailbox is empty — nothing to analyze yet.\n");
      process.exit(0);
    }

    const start = Math.max(1, exists - limit + 1);
    const recent = [];

    for await (const msg of client.fetch(`${start}:*`, { source: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      recent.push({
        date: parsed.date?.toISOString().slice(0, 10) ?? "?",
        from: parsed.from?.value?.[0]?.address ?? "?",
        subject: (parsed.subject ?? "(no subject)").slice(0, 58),
      });
    }

    console.log(`\n  Newest ${recent.length}:\n`);
    for (const m of recent) {
      console.log(`    ${m.date}  ${m.from.padEnd(30).slice(0, 30)}  ${m.subject}`);
    }

    const self = recent.filter((m) => m.from.toLowerCase() === user.toLowerCase());
    console.log(
      `\n  ${recent.length - self.length} inbound, ${self.length} sent by you.`,
    );
    console.log(
      `  The app will analyze the inbound ones and use the sent ones for thread context.\n`,
    );
  } finally {
    lock.release();
  }
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error);

  if (/AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(raw)) {
    fail(
      "Authentication failed.",
      "Check that IMAP is enabled in Gmail (Settings → Forwarding and POP/IMAP) and that you are using a 16-character APP PASSWORD, not your account password.",
    );
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    fail(`Could not resolve ${host}.`, "Check IMAP_HOST and your network.");
  } else if (/ETIMEDOUT|timeout/i.test(raw)) {
    fail(
      `Timed out connecting to ${host}:${port}.`,
      "Port 993 must be reachable — a firewall or VPN may be blocking it.",
    );
  } else {
    fail("Connection failed.", raw.slice(0, 300));
  }
} finally {
  await client.logout().catch(() => undefined);
}
