import { listNoise, listTriaged, getStats } from "@/lib/db/repo";
import { dbFilePath, schemaVersion } from "@/lib/db/client";
import { getEngineStatus } from "@/lib/pipeline/engine";
import { ensureSeeded } from "@/lib/seed";

/**
 * Health + self-verification endpoint.
 *
 * This is not a liveness ping. It re-asserts the invariant that makes the trace
 * trustworthy: for every persisted decision,
 *
 *     deterministicScore + personaBias + modelAdjustment === finalScore
 *
 * and the band must be exactly what that score implies. If the pipeline ever
 * produces an unattributable score, this endpoint fails loudly.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();

  const mails = listTriaged({ includeNoise: true });
  const noise = listNoise();
  const stats = getStats();
  const status = getEngineStatus();

  const failures: {
    messageId: string;
    subject: string;
    reason: string;
  }[] = [];

  let traced = 0;
  let capped = 0;

  for (const { message, decision } of mails) {
    if (!decision) {
      failures.push({
        messageId: message.id,
        subject: message.subject,
        reason: "no decision recorded",
      });
      continue;
    }

    const t = decision.trace;
    traced += 1;

    const sum = t.deterministicScore + t.personaBias + t.modelAdjustment;
    const expectedFinal = Math.min(100, Math.max(0, sum));

    if (expectedFinal !== t.finalScore) {
      failures.push({
        messageId: message.id,
        subject: message.subject,
        reason: `score mismatch: ${t.deterministicScore} + ${t.personaBias} + ${t.modelAdjustment} = ${sum}, expected clamp ${expectedFinal}, got ${t.finalScore}`,
      });
    }

    const expectedBand =
      t.finalScore >= 90
        ? "P0"
        : t.finalScore >= 70
          ? "P1"
          : t.finalScore >= 40
            ? "P2"
            : "P3";

    if (expectedBand !== t.band || t.band !== decision.priorityBand) {
      failures.push({
        messageId: message.id,
        subject: message.subject,
        reason: `band mismatch: score ${t.finalScore} implies ${expectedBand}, trace says ${t.band}, decision says ${decision.priorityBand}`,
      });
    }

    if (Math.abs(t.modelAdjustment) > 15) {
      failures.push({
        messageId: message.id,
        subject: message.subject,
        reason: `model adjustment ${t.modelAdjustment} exceeds the ±15 cap`,
      });
    }

    if (Math.abs(t.modelAdjustment) === 15) capped += 1;
  }

  const ok = failures.length === 0;

  return Response.json(
    {
      ok,
      engine: status.mode,
      models: { flash: status.flashModel, pro: status.proModel },
      engineReason: status.reason,
      storage: { schemaVersion: schemaVersion(), path: dbFilePath() },
      counts: {
        ranked: mails.filter((m) => !m.decision?.noise.isNoise).length,
        noise: noise.length,
        traced,
        modelAdjustmentCapped: capped,
      },
      bands: stats.byBand,
      byEngine: stats.byEngine,
      cost: {
        totalUsd: stats.totalCostUsd,
        avgLatencyMs: stats.avgLatencyMs,
        cacheHitRate: stats.cacheHitRate,
      },
      traceFailures: failures,
    },
    { status: ok ? 200 : 500 },
  );
}
