import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { QdrantClient } from "@qdrant/qdrant-js";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let jiraContext = "";

const qdrant = new QdrantClient({
  url: "http://localhost:6333",
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history } = req.body ?? {};

    if (typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: 'Invalid or missing "message" in request body.' });
    }

    const userMessage = message.trim();

    const embedding = await createEmbedding(userMessage);

    const searchResult = await qdrant.search("jira_issues", {
      vector: embedding,
      limit: 3,
    });

    console.log(searchResult);

    const jiraContext = searchResult
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

    let conversationSection = "";
    if (Array.isArray(history) && history.length > 0) {
      const formatted = history
        .filter(
          (turn) =>
            typeof turn?.role === "string" && typeof turn?.content === "string",
        )
        .map((turn, index) => {
          const speaker =
            turn.role === "assistant"
              ? "Assistant"
              : turn.role === "user"
                ? "User"
                : "Unknown";
          return `Turn ${index + 1} - ${speaker}: ${turn.content}`;
        })
        .join("\n");

      if (formatted) {
        conversationSection = `\n\nConversation so far:\n${formatted}\n`;
      }
    }

    const systemPrompt = `
      You are an enterprise Jira assistant.

      You must answer ONLY using the provided context below.
      If the answer is not present in the context, respond with:
      "I do not have enough information."

      Do not use external knowledge.

Context:
${jiraContext}

${conversationSection}

User Question:
${userMessage}
`.trim();

    const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama2",
        messages: [
          {
            role: "user",
            content: systemPrompt,
          },
        ],
        stream: true,
      }),
    });

    if (!ollamaResponse.ok) {
      throw new Error(
        `Ollama request failed with status ${ollamaResponse.status}`,
      );
    }

    if (!ollamaResponse.body) {
      throw new Error("Ollama response has no body to stream.");
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const reader = ollamaResponse.body.getReader();
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
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          const token = parsed?.message?.content ?? "";
          if (token) {
            fullText += token;
            res.write(token);
          }
        } catch (parseError) {
          console.warn("Failed to parse Ollama stream chunk:", parseError);
        }
      }
    }

    if (!fullText.trim()) {
      res.write("I do not have enough information.");
    }

    res.end();
    return;
  } catch (error) {
    console.error("Error handling /chat request:", error);
    return res.status(500).json({ error: "Failed to process the request." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

async function createEmbedding(text) {
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
