import { QdrantClient } from "@qdrant/qdrant-js";

const QDRANT_URL = "http://localhost:6333";
const QDRANT_COLLECTION = "jira_issues";
const OLLAMA_URL = "http://localhost:11434";

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
  });

  const data = await res.json();
  return data.embedding;
}

async function generateAnswer(prompt) {
  //   const res = await fetch(`http://localhost:11434/api/chat`, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       model: "llama2",
  //       messages: [
  //         {
  //           role: "user",
  //           content: prompt,
  //         },
  //       ],
  //       stream: true,
  //     }),
  //   });

  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama2",
      messages: [
        {
          role: "user",
          content: "Hello",
        },
      ],
      stream: true,
    }),
  });

  const data = await res.json();

  return data.message?.content;
}

async function main() {
  await generateAnswer("Hello");
  return;
  const client = new QdrantClient({ url: QDRANT_URL });

  const userQuery = "tab close button overlapping repository name";

  // 1️⃣ Embed query
  const queryVector = await embed(userQuery);

  // 2️⃣ Search Qdrant
  const results = await client.search(QDRANT_COLLECTION, {
    vector: queryVector,
    limit: 3,
  });

  console.log(
    "Top matches:",
    results.map((r) => ({
      score: r.score,
      issue: r.payload.issue_key,
    })),
  );

  // 3️⃣ Build context
  const context = results
    .map(
      (r) =>
        `Issue: ${r.payload.issue_key}
Summary: ${r.payload.summary}
Description: ${r.payload.description}`,
    )
    .join("\n\n");

  // 4️⃣ Ask Ollama with retrieved context
  const finalPrompt = `
You are a Jira assistant.
Use the following issues to answer the question.

${context}

Question: ${userQuery}
Answer clearly:
`;

  const answer = await generateAnswer(finalPrompt);

  console.log("\nAI Answer:\n", answer);
}

main();

// You are an enterprise Jira assistant.

// You must answer ONLY using the provided context below.
// If the answer is not present in the context, respond with:
// "I do not have enough information."

// Do not use external knowledge.
