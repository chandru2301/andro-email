import { register } from "node:module";
register(new URL("./ts-resolver.mjs", import.meta.url));

process.env.ANDRO_DB_DIR = new URL("../.cache/state-test-db", import.meta.url).pathname;
const repo = await import("../src/lib/db/repo.ts");

const mk = (id) => ({
  id, gmailMessageId: id, gmailThreadId: `t-${id}`,
  from: { name: "T", email: "t@example.com" }, to: [{ email: "me@example.com" }],
  cc: [], subject: `Subject ${id}`, cleanBody: "body", snippet: "body",
  receivedAt: new Date().toISOString(), labelIds: ["INBOX", "UNREAD"],
  headers: {}, hasAttachments: false, attachmentNames: [],
  isFromMe: false, contentHash: `h-${id}`, priorUserReplied: false,
});

repo.ensureAccount("me@example.com", "test");
for (const id of ["m1", "m2", "m3"]) repo.insertMessage(mk(id));

const ids = (f) => repo.listTriaged(f).map((r) => r.message.id).sort().join(",") || "(none)";
let failures = 0;
const ok = (label, got, want) => {
  const pass = got === want;
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(40)} got=${String(got).padEnd(10)} want=${want}`);
};

console.log("\ninitial");
ok("active", ids(), "m1,m2,m3");
ok("state counts", JSON.stringify(repo.getMailStateCounts()), '{"active":3,"archived":0,"trash":0}');

console.log("\narchive m1  (e)");
repo.setArchived("m1", true);
ok("active queue", ids(), "m2,m3");
ok("archived lane", ids({ state: "archived" }), "m1");
ok("state counts", JSON.stringify(repo.getMailStateCounts()), '{"active":2,"archived":1,"trash":0}');

console.log("\narchive m2 then delete it  (must leave the archive)");
repo.setArchived("m2", true);
repo.setDeleted("m2", true);
ok("archived lane", ids({ state: "archived" }), "m1");
ok("trash lane", ids({ state: "trash" }), "m2");
ok("state counts", JSON.stringify(repo.getMailStateCounts()), '{"active":1,"archived":1,"trash":1}');

console.log("\nrestore m2 from trash");
repo.setDeleted("m2", false);
ok("trash lane", ids({ state: "trash" }), "(none)");
ok("active queue", ids(), "m2,m3");

console.log("\nunarchive m1");
repo.setArchived("m1", false);
ok("active queue", ids(), "m1,m2,m3");

console.log("\npurge m3 forever");
repo.purgeMessage("m3");
ok("active queue", ids(), "m1,m2");
ok("state counts", JSON.stringify(repo.getMailStateCounts()), '{"active":2,"archived":0,"trash":0}');

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
