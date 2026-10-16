import type { RawMessageLike } from "../types";

/**
 * A mail source is anything that can produce raw messages.
 *
 * The pipeline never knows whether mail came from Gmail or a fixture file, which
 * is what lets the whole decision engine be developed and evaluated offline.
 */
export type MailSource = {
  id: string;
  label: string;
  description: string;
  fetchMessages(): Promise<RawMessageLike[]>;
};

export type SourceStatus = {
  id: string;
  label: string;
  description: string;
  available: boolean;
  detail: string;
};
