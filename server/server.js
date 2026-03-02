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

    const intent = await analyzePrompt(userMessage);

    switch (intent.intent) {
      case "issue_lookup": {
        console.log("Issue Lookup");

        const jiraContext = await getIssueByKey(intent.issue_key);

        const prompt = buildPrompt({
          context: jiraContext,
          history: req.body.history,
          question: userMessage,
        });

        return streamOllamaResponse(prompt, res);
      }
      case "general_chat": {
        const prompt = buildPrompt({
          context: "",
          history: req.body.history,
          question: userMessage,
        });

        return streamOllamaResponse(prompt, res);
      }
      case "related_issues": {
        const jiraContext = await getRelatedIssues(intent.issue_key);

        const prompt = buildPrompt({
          context: jiraContext,
          history: req.body.history,
          question: userMessage,
        });

        return streamOllamaResponse(prompt, res);
      }
    }
    // semantic_search fallback
    const embedding = await getEmbedding(userMessage);
    const searchResults = await searchJira(embedding);
    const jiraContext = buildContext(searchResults);
    // return console.log(jiraContext);
    console.log(jiraContext);
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
  console.log("Validating Request");
  const { message } = body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Invalid message");
  }
  return message.trim();
}

async function getEmbedding(text) {
  console.log("Getting Embedding");
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
  console.log("Searching Jira");
  return await qdrant.search("jira_issues", {
    vector,
    limit: 3, // number of search results
  });
}

function buildContext(results) {
  console.log("Building Context");
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
  console.log("Building Prompt");
  const conversation = formatHistory(history);
  // context = objectToReadableText(context);
  return `
  You are Shrek as a Jira assistant.Use the following context to answer the user's question and be direct.
  RULES:
    1. Use ONLY the information present in the context.
    2. Do NOT infer, assume, or generate missing values.
    3. Do NOT summarize.
    4. Do NOT explain.
    5. Do NOT add extra text.

  ===== Context =====
  ${context}
  ======================
  
  =====   User Question: =====
  ${question}
  ======================
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
  console.log("Streaming Ollama Response");
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

async function getIssueByKey(issueKey) {
  console.log("Getting Issue By Key");
  const result = await qdrant.scroll("jira_issues", {
    limit: 1,
    with_payload: true,
    filter: {
      must: [
        {
          key: "issue_key",
          match: { value: issueKey },
        },
      ],
    },
  });
  return result.points?.[0].payload ?? null;
}

async function analyzePrompt(message) {
  const issueKeyRegex = /[A-Z]+-\d+/i;
  const match = message.match(issueKeyRegex);

  if (match) {
    const issueKey = match[0].toUpperCase();

    // If user is asking for similar/related issues
    if (/similar|related|like|matching|comparable/i.test(message)) {
      return {
        intent: "related_issues",
        issue_key: issueKey,
      };
    }

    // Otherwise treat as lookup
    return {
      intent: "issue_lookup",
      issue_key: issueKey,
    };
  }

  // No issue key → let LLM decide
  return await streamOllamaIntent(message);
}

async function streamOllamaIntent(message) {
  const prompt = `
          You are an intent classifier for a Jira AI assistant.

      Analyze the user message and return a JSON object with this exact structure:

      {
        "intent": "<one of: semantic_search | general_chat>",
        "issue_key": "<issue key if present, otherwise null>"
      }
        =====   Example response:  =====
              1. {
                "intent": "semantic_search",
                "issue_key": "null"
              }
              2. {
                "intent": "general_chat",
                "issue_key": null
              }
          ======================



      IMPORTANT RULES:
      - Problem descriptions without issue keys are semantic_search.

      Types:

      1. general_chat
        - Only greetings or small talk.
        - No Jira-related request.
        - Non-Jira questions or unrelated conversation.

      2. semantic_search
        - The user describes a problem, behavior, release delay, bug, or question.
        - No explicit issue key is mentioned.
        - Requires searching Jira issues by meaning.
       
          If no issue key is present, issue_key must be null.

         =====   User message: =====
              ${message}
          ======================

      Respond ONLY with valid JSON.
      Do not explain anything.

        `;
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
          content: prompt,
        },
      ],
      stream: false,
    }),
  });

  const data = await res.json();
  let parsedData;
  try {
    parsedData = JSON.parse(data.message?.content);
  } catch (err) {
    console.error("Invalid JSON from LLM:", data.message?.content);
    throw new Error("Intent parsing failed");
  }
  return parsedData;
}

function objectToReadableText(obj) {
  return Object.entries(obj)
    .map(([key, value]) => {
      if (typeof value === "object" && value !== null) {
        return `${key}:\n${JSON.stringify(value, null, 2)}`;
      }
      return `${key}: ${value}`;
    })
    .join("\n");
}

async function getRelatedIssues(issueKey) {
  try {
    // Get the issue data
    const issue = await getIssueByKey(issueKey);

    if (!issue) {
      throw new Error(`Issue ${issueKey} not found`);
    }

    // Create text to embed
    const textToEmbed = `
      ${issue.summary}
      ${issue.description || ""}
    `;

    // Generate embedding
    const embedding = await getEmbedding(textToEmbed);

    // Search Qdrant for similar issues
    const searchResults = await searchJira(embedding);

    // Remove the same issue from results
    const filtered = searchResults.filter(
      (item) => item.payload.issue_key !== issueKey,
    );

    return filtered;
  } catch (error) {
    console.error("Error fetching related issues from Qdrant:", error);
    throw error;
  }
}
