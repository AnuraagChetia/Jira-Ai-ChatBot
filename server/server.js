import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { QdrantClient } from "@qdrant/qdrant-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const qdrant = new QdrantClient({
  url: "http://localhost:6333",
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = validateRequest(req.body);

    const embedding = await getEmbedding(userMessage);

    const searchResults = await searchJira(embedding);

    console.log(searchResults);

    const jiraContext = buildContext(searchResults);

    const prompt = buildPrompt({
      context: jiraContext,
      history: req.body.history,
      question: userMessage,
    });

    await streamOllamaResponse(prompt, res);
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Helper Functions **BELOW**
function validateRequest(body) {
  const { message } = body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Invalid message");
  }
  return message.trim();
}

async function getEmbedding(text) {
  const res = await fetch(`http://localhost:11434/api/embeddings`, {
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
      `Ollama embeddings failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = await res.json();
  if (!Array.isArray(data.embedding)) {
    throw new Error("Missing or invalid 'embedding' field from Ollama.");
  }
  return data.embedding;
}

async function searchJira(vector) {
  return await qdrant.search("jira_issues", {
    vector,
    limit: 3, // number of search results
  });
}

function buildContext(results) {
  if (!results.length) return "";

  return results
    .map((item, index) => {
      const p = item.payload;

      return `
  Result ${index + 1}
  Issue Key: ${p.issue_key}
  Status: ${p.status}
  Summary: ${p.summary}
  Description: ${p.description}
  Similarity Score: ${item.score}
  `;
    })
    .join("\n");
}

function buildPrompt({ context, history, question }) {
  const conversation = formatHistory(history);

  return `
  You are an enterprise Jira assistant.
  
 
  
  Context:
  ${context}
  
  ${conversation}
  
  User Question:
  ${question}
  `.trim();
}

function formatHistory(history) {
  if (!Array.isArray(history) || !history.length) return "";

  const formatted = history
    .filter(
      (turn) =>
        typeof turn?.role === "string" && typeof turn?.content === "string",
    )
    .map((turn, i) => `Turn ${i + 1} - ${turn.role}: ${turn.content}`)
    .join("\n");

  return formatted ? `\nConversation so far:\n${formatted}\n` : "";
}

async function streamOllamaResponse(prompt, res) {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama2",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });

  if (!response.body) {
    throw new Error("No response body from Ollama");
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);
        const token = parsed?.message?.content ?? "";

        if (token) {
          fullText += token;
          res.write(token);
        }
      } catch {}
    }
  }

  if (!fullText.trim()) {
    res.write("I do not have enough information.");
  }

  res.end();
}
