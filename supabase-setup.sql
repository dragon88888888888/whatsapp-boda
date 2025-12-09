-- Habilitar la extensión pgvector
create extension if not exists vector;

-- Crear tabla para documentos con embeddings
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  metadata jsonb,
  embedding vector(1536), -- OpenAI embeddings son de dimensión 1536
  created_at timestamp with time zone default now()
);

-- Crear índice para búsqueda de similitud (HNSW es más rápido que IVFFlat)
create index if not exists documents_embedding_idx
on documents using hnsw (embedding vector_cosine_ops);

-- Función para búsqueda de similitud
create or replace function match_documents (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
$$;

-- Crear tabla para historial de conversaciones
create table if not exists conversation_history (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  message text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  created_at timestamp with time zone default now()
);

-- Índice para consultas rápidas por usuario
create index if not exists conversation_history_user_id_idx
on conversation_history (user_id, created_at desc);

-- Crear tabla para metadata de PDFs
create table if not exists pdf_files (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_path text not null,
  file_type text not null,
  category text,
  description text,
  storage_path text not null,
  created_at timestamp with time zone default now()
);

-- Índice para búsqueda por categoría y nombre
create index if not exists pdf_files_category_idx on pdf_files (category);
create index if not exists pdf_files_file_name_idx on pdf_files (file_name);
