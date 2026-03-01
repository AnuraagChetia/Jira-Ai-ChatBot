# Jira AI Chatbot – RAG Prototype

A Retrieval-Augmented Generation (RAG) based AI assistant built on top of Jira issue data.

This prototype allows you to:

- Ingest Jira issues from a CSV dataset
- Generate embeddings using Ollama
- Store vectors inside Qdrant
- Retrieve semantically similar issues
- Generate grounded AI responses using LLaMA2

The system answers questions strictly using retrieved Jira context.

---

# Architecture Overview

User Question  
→ Generate embedding (Ollama)  
→ Search similar vectors (Qdrant)  
→ Build context  
→ Send to LLM (Ollama chat API)  
→ Stream response  

This is a standard RAG (Retrieval-Augmented Generation) pipeline.

---

# Tech Stack
- Vite React
- Node.js + Express
- Qdrant (Vector Database)
- Ollama (Embeddings + LLM)
- Docker (Qdrant runtime)

---

# Prerequisites

Install the following:

- Node.js (v18+ recommended)
- Docker
- Ollama

---

# 1. Start Qdrant (Vector Database)

Run Qdrant using Docker:

## Windows (PowerShell)
```bash
docker run -p 6333:6333 qdrant/qdrant
```
Qdrant will be available at:

http://localhost:6333/dashboard

# 2. Install and Setup Ollama

Download and install from:

https://ollama.com

Pull required models:
```base
ollama pull llama2
ollama pull nomic-embed-text
```
Verify installation:
```bash
ollama run llama2
```
If it responds, Ollama is working.
# 3. Install Project Dependencies

Inside the project directory:
```bash
npm install
```
# 4. Create Qdrant Collection
Start Qdrant container and run the ingestor script. Be sure to keep the sample csv file inside the server folder.
```bash
docker run -p 6333:6333 qdrant/qdrant
node ingestJiraToQdrant.mjs
```
Check Qdrant dashboard if the collection was created properly.
# 6. Start the Server and Client
## For Server:
```bash
npm run dev
```
## For Client:
```bash
npm start
```



