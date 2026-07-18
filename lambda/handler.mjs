// Refresher Lambda: rebuilds the streaks payload and publishes it to S3,
// where the site fetches it directly (no Amplify rebuild needed).
//
// Writes two objects per run:
//   streaks.json                 — the live payload the site polls
//   history/YYYY-MM-DD.json      — daily snapshot (last write of the day wins),
//                                  the seed for future historical views
//
// Runs on an EventBridge schedule; see infra/template.yaml.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { buildStreaksPayload } from "./src/streaks.mjs";

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET;

export async function handler() {
  if (!BUCKET) throw new Error("DATA_BUCKET env var is not set");

  const startedAt = Date.now();
  const payload = await buildStreaksPayload({
    season: Number(process.env.SEASON) || undefined,
    log: console.log,
  });
  const body = JSON.stringify(payload, null, 2) + "\n";

  // no-cache => browsers revalidate with If-None-Match and get a cheap 304
  // from S3 when the data hasn't changed.
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: "streaks.json",
      Body: body,
      ContentType: "application/json",
      CacheControl: "no-cache",
    })
  );

  const day = payload.generatedAt.slice(0, 10); // YYYY-MM-DD (UTC)
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `history/${day}.json`,
      Body: body,
      ContentType: "application/json",
      CacheControl: "public, max-age=3600",
    })
  );

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const leader = payload.streaks[0];
  const summary =
    `Published ${payload.streaks.length} streaks to s3://${BUCKET} in ${secs}s.` +
    (leader ? ` Leader: ${leader.name} (${leader.streak} games).` : " No active streaks.");
  console.log(summary);
  return { ok: true, generatedAt: payload.generatedAt, leader: leader?.name ?? null, streaks: payload.streaks.length };
}
