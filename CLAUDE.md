# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bot de WhatsApp para asistente de itinerario de viaje usando RAG (Retrieval-Augmented Generation) con LangChain, Supabase y OpenAI. El bot responde consultas sobre itinerarios de viaje y puede enviar documentos PDF relevantes.

## Commands

```bash
# Iniciar el bot (WhatsApp Cloud API)
npm start

# Desarrollo con hot-reload
npm run dev

# Indexar documentos PDF en Supabase
npm run index

# Subir PDFs a Supabase Storage
npm run upload-pdfs

# Chat interactivo en terminal (para testing)
npm run chat

# Docker
docker-compose up --build
```

## Architecture

### Core Components

- **chatwhats.js**: Bot principal usando WhatsApp Cloud API (Meta). Servidor Express que recibe webhooks de WhatsApp y procesa mensajes.
- **chatwhats-evolution.js**: Variante del bot usando Evolution API (alternativa self-hosted a WhatsApp Cloud API). Incluye filtrado de numeros permitidos via `allowed-numbers.json`.
- **rag-chat.js**: Sistema RAG agentico con LangGraph. Contiene `AgenticRAGSystem` que:
  - Usa Supabase como vector store para busqueda semantica
  - Integra MCP tools para consultas SQL a Supabase
  - Procesa PDFs encontrados en respuestas y los descarga automaticamente
- **document-index.js**: Indexador de PDFs. Lee archivos de `./fwdviajemiguelyvero/`, los divide en chunks y los almacena en Supabase con embeddings de OpenAI.
- **pdf-storage.js**: Utilidades para subir PDFs a Supabase Storage y generar URLs firmadas.

### Data Flow

1. Webhook recibe mensaje de WhatsApp
2. `AgenticRAGSystem.processQuery()` procesa la consulta:
   - Recupera documentos relevantes del vector store
   - LLM genera respuesta usando contexto + MCP tools
   - Post-procesamiento descarga PDFs de URLs en la respuesta
3. Bot envia respuesta de texto y documentos adjuntos

### External Services

- **Supabase**: Vector store (tabla `documents`), almacenamiento de PDFs (bucket `wedding-documents`), historial de conversaciones
- **OpenAI**: Embeddings (`text-embedding-3-small`) y chat completion (`gpt-4o-mini`)
- **MCP Server**: Supabase MCP para consultas SQL dinamicas (configurado en `mcp.json`)

## Environment Variables

Ver `.env.example` para la lista completa. Variables criticas:
- `OPENAI_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `WHATSAPP_API_TOKEN`, `WHATSAPP_CLOUD_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`

Para Evolution API: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`

## Project Conventions

- genera codigo limpio y sin emojis
- no crees ni modifiques documentacion hasta que te lo pida
- ES Modules (type: module en package.json)
- Codigo y comentarios en espanol
