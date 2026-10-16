import { fixtureMessages, OWNER } from "../fixtures/corpus";
import type { RawMessageLike } from "../types";
import type { MailSource } from "./types";

/**
 * Fixture source.
 *
 * This is the default because it is the only way the app runs end-to-end with
 * zero credentials — and because the golden set has to live somewhere.
 */
export const mockSource: MailSource = {
  id: "mock",
  label: "Fixture corpus",
  description:
    "A bundled, hand-authored inbox spanning every persona, including phishing and noise. No credentials required.",
  async fetchMessages(): Promise<RawMessageLike[]> {
    return fixtureMessages.map((m) => ({ ...m }));
  },
};

export { OWNER as FIXTURE_OWNER };
