import type { Persona } from "./types";

/**
 * Starter persona set (PLAN.md §6.2).
 *
 * A persona is a *hat the user wears*, not a folder — it answers "which version
 * of me is this mail for?". `description` is not decoration: it is the rubric
 * handed to the model when classifying, so it is written for a reader, not a UI.
 *
 * `priorityWeights` are small non-negative integers. They are applied
 * deterministically in `reconcile.ts` — the model never sets them.
 */

const ALL_FACTORS = {
  senderRelationship: 3,
  deadline: 3,
  money: 1,
  replyNeeded: 3,
};

export const PERSONAS: Persona[] = [
  {
    id: "work-client",
    name: "Work — Client",
    icon: "Briefcase",
    description:
      "Mail from clients, prospects and external partners about active engagements: scopes of work, proposals, contracts, deliverables, invoices raised to clients, and project questions. The owner is accountable to these people.",
    senderPatterns: ["northwind.co", "lumenlabs.io"],
    keywords: [
      "sow",
      "statement of work",
      "proposal",
      "contract",
      "deliverable",
      "scope",
      "engagement",
      "redline",
      "milestone",
    ],
    priorityWeights: {
      senderRelationship: 4,
      deadline: 4,
      money: 3,
      replyNeeded: 4,
    },
    autoActions: {
      archiveNoise: false,
      labelInGmail: true,
      neverAutoArchive: true,
    },
    isSystem: true,
  },
  {
    id: "work-internal",
    name: "Work — Internal",
    icon: "Users",
    description:
      "Mail from colleagues inside the owner's own company: standups, code review requests, ticket assignments, planning, HR notices and team announcements.",
    senderPatterns: [],
    keywords: [
      "standup",
      "sprint",
      "pull request",
      "pr review",
      "ticket",
      "deploy",
      "retro",
      "on-call",
    ],
    priorityWeights: {
      senderRelationship: 3,
      deadline: 3,
      money: 0,
      replyNeeded: 3,
    },
    autoActions: {
      archiveNoise: false,
      labelInGmail: true,
      neverAutoArchive: false,
    },
    isSystem: true,
  },
  {
    id: "founder",
    name: "Founder / Ops",
    icon: "Rocket",
    description:
      "Investor relations, fundraising, legal and corporate matters, hiring and recruiting for the company, vendors and service providers. Company-shaping decisions rather than delivery work.",
    senderPatterns: [],
    keywords: [
      "investor",
      "term sheet",
      "cap table",
      "runway",
      "board",
      "legal",
      "counsel",
      "vendor",
      "candidate",
      "offer letter",
    ],
    priorityWeights: {
      senderRelationship: 3,
      deadline: 4,
      money: 4,
      replyNeeded: 3,
    },
    autoActions: {
      archiveNoise: false,
      labelInGmail: true,
      neverAutoArchive: true,
    },
    isSystem: true,
  },
  {
    id: "finance",
    name: "Finance",
    icon: "Wallet",
    description:
      "Invoices, payment failures, bank and card statements, tax, accounting and subscription billing. Includes both amounts owed to the owner and amounts the owner owes.",
    senderPatterns: [],
    keywords: [
      "invoice",
      "payment failed",
      "statement",
      "remittance",
      "tax",
      "1099",
      "gst",
      "renewal",
      "amount due",
    ],
    priorityWeights: {
      senderRelationship: 2,
      deadline: 3,
      money: 5,
      replyNeeded: 2,
    },
    autoActions: {
      archiveNoise: true,
      labelInGmail: true,
      neverAutoArchive: false,
    },
    isSystem: true,
  },
  {
    id: "oss",
    name: "Open Source",
    icon: "GitBranch",
    description:
      "GitHub and GitLab activity, CI results, issue trackers, dependency advisories, package registries and developer mailing lists. Usually automated and rarely requires a reply.",
    senderPatterns: ["github.com", "gitlab.com", "npmjs.com"],
    keywords: [
      "pull request",
      "issue",
      "workflow run",
      "build failed",
      "dependabot",
      "release",
      "merge",
    ],
    priorityWeights: {
      senderRelationship: 1,
      deadline: 1,
      money: 0,
      replyNeeded: 2,
    },
    autoActions: {
      archiveNoise: true,
      labelInGmail: true,
      neverAutoArchive: false,
    },
    isSystem: true,
  },
  {
    id: "recruiter",
    name: "Recruiter",
    icon: "UserPlus",
    description:
      "Inbound recruiting and staffing outreach: role pitches, availability checks, agency introductions. Rarely urgent and often templated.",
    senderPatterns: ["linkedin.com", "hiretalent", "staffing"],
    keywords: [
      "opportunity",
      "exciting role",
      "your background",
      "quick call",
      "competitive salary",
      "contract role",
    ],
    priorityWeights: {
      senderRelationship: 1,
      deadline: 0,
      money: 1,
      replyNeeded: 1,
    },
    autoActions: {
      archiveNoise: true,
      labelInGmail: true,
      neverAutoArchive: false,
    },
    isSystem: true,
  },
  {
    id: "personal",
    name: "Personal",
    icon: "Heart",
    description:
      "Friends, family, appointments, personal bookings and anything from a known personal contact. Overrides quiet hours.",
    senderPatterns: [],
    keywords: ["dinner", "birthday", "appointment", "booking", "family"],
    priorityWeights: {
      senderRelationship: 5,
      deadline: 3,
      money: 1,
      replyNeeded: 4,
    },
    autoActions: {
      archiveNoise: false,
      labelInGmail: true,
      neverAutoArchive: true,
    },
    isSystem: true,
  },
  {
    id: "noise",
    name: "Noise",
    icon: "Archive",
    description:
      "Promotions, newsletters, social notifications, product marketing and anything the owner is unlikely to read. Collapses into the daily digest rather than the ranked queue.",
    senderPatterns: [],
    keywords: ["unsubscribe", "sale", "newsletter", "digest", "weekly"],
    priorityWeights: {
      senderRelationship: 0,
      deadline: 0,
      money: 0,
      replyNeeded: 0,
    },
    autoActions: {
      archiveNoise: true,
      labelInGmail: true,
      neverAutoArchive: false,
    },
    isSystem: true,
  },
];

export const DEFAULT_PERSONA_ID = "work-internal";

export function getPersona(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

export function personaName(id: string): string {
  return getPersona(id)?.name ?? id;
}

export { ALL_FACTORS };
