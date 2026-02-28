import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import { QdrantClient } from "@qdrant/qdrant-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH =
  process.env.JIRA_CSV_PATH ?? path.join(__dirname, "GFG_FINAL.csv");
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY; // optional
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? "jira_issues";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MAX_POINTS = Number(process.env.MAX_JIRA_POINTS ?? "100");

// Dimension for nomic-embed-text
const EMBED_DIM = 768;
const BATCH_SIZE = 16;
// nomic-embed-text context limit ~8192 tokens; truncate to stay under
const MAX_INPUT_CHARS = 6000;

function buildText(row) {
  const summary = (row["Summary"] ?? "").slice(0, 2000);
  const description = (row["Description"] ?? "").slice(0, 3500);
  const issueKey = row["Issue key"] ?? "";
  const status = row["Status"] ?? "";

  const parts = [];
  if (issueKey) parts.push(`Issue key: ${issueKey}`);
  if (summary) parts.push(`Summary: ${summary}`);
  if (status) parts.push(`Status: ${status}`);
  if (description) parts.push(`Description: ${description}`);

  let text = parts.join("\n").trim();
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS);
  }
  return text;
}

async function embedWithOllama(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Ollama embeddings failed (${res.status}): ${body.slice(0, 200)}`
    );
  }

  const data = await res.json();
  if (!Array.isArray(data.embedding)) {
    throw new Error("Missing or invalid 'embedding' field from Ollama.");
  }
  return data.embedding;
}

async function ensureCollection(client) {
  const collections = await client.getCollections();
  const exists =
    collections.collections?.some(
      (c) => c.name === QDRANT_COLLECTION
    ) ?? false;

  if (exists) return;

  await client.createCollection(QDRANT_COLLECTION, {
    vectors: {
      size: EMBED_DIM,
      distance: "Cosine",
    },
  });
}

async function flushBatch(batch, client, startId) {
  console.log(`Embedding batch of ${batch.length} rows...`);

  const vectors = [];
  for (const { text } of batch) {
    const emb = await embedWithOllama(text);
    vectors.push(emb);
  }

  const points = batch.map(({ row }, idx) => ({
    id: startId + idx,
    vector: vectors[idx],
    payload: {
      summary: row["Summary"],
      description: row["Description"],
      issue_key: row["Issue key"],
      status: row["Status"],
      raw: row,
    },
  }));

  await client.upsert(QDRANT_COLLECTION, {
    wait: true,
    points,
  });

  console.log(
    `Upserted ${points.length} points (last id=${startId + points.length - 1})`
  );
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV not found at ${CSV_PATH}`);
  }

  const client = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
  });

  await ensureCollection(client);

  console.log(
    `Ingesting up to ${MAX_POINTS} issues from ${CSV_PATH} into '${QDRANT_COLLECTION}'`
  );

  const stream = fs.createReadStream(CSV_PATH);
  const parser = stream.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
    })
  );

  let pointId = 1;
  let batch = [];

  for await (const row of parser) {
    if (pointId > MAX_POINTS) break;

    const text = buildText(row);
    if (!text) continue;

    batch.push({ row, text });

    if (batch.length >= BATCH_SIZE || pointId + batch.length - 1 > MAX_POINTS) {
      await flushBatch(batch, client, pointId);
      pointId += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0 && pointId <= MAX_POINTS) {
    await flushBatch(batch, client, pointId);
    pointId += batch.length;
  }

  console.log(`Done. Inserted ${Math.min(pointId - 1, MAX_POINTS)} points.`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});

