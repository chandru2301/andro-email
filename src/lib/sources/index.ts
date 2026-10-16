import { createImapSource, imapConfig, imapStatus } from "./imap";
import { mockSource } from "./mock";
import type { MailSource, SourceStatus } from "./types";

/**
 * Active source selection.
 *
 * IMAP wins when it is configured, because a configured mailbox is obviously
 * what the user wants to see. Otherwise the fixture corpus keeps the app
 * runnable and the decision engine testable with no credentials at all.
 */

export type SourceId = "imap" | "mock";

export function activeSourceId(): SourceId {
  return imapConfig() ? "imap" : "mock";
}

export function getActiveSource(): MailSource {
  return activeSourceId() === "imap" ? createImapSource() : mockSource;
}

export function listSourceStatuses(): SourceStatus[] {
  return [
    imapStatus(),
    {
      id: mockSource.id,
      label: mockSource.label,
      description: mockSource.description,
      available: true,
      detail: "Always available.",
    },
  ];
}

export { imapStatus, mockSource };
export type { MailSource, SourceStatus };
