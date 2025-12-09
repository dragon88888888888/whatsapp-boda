# Configuración de Supabase

## 1. Crear proyecto en Supabase

1. Ve a https://supabase.com y crea una cuenta
2. Crea un nuevo proyecto
3. Guarda la URL del proyecto y la anon key

## 2. Ejecutar el script SQL

1. En el dashboard de Supabase, ve a SQL Editor
2. Crea una nueva query
3. Copia y pega todo el contenido de `supabase-setup.sql`
4. Ejecuta el script

Esto creará:
- Extensión pgvector para búsqueda vectorial
- Tabla `documents` para almacenar embeddings
- Tabla `conversation_history` para historial de chats
- Tabla `pdf_files` para metadata de PDFs
- Funciones e índices necesarios

## 3. Configurar Storage para PDFs

1. En el dashboard de Supabase, ve a Storage
2. Crea un nuevo bucket llamado `wedding-documents`
3. Configuración recomendada:
   - Public: No (privado)
   - File size limit: 50 MB
   - Allowed MIME types: application/pdf

## 4. Configurar políticas de acceso (RLS)

### Para la tabla documents:
```sql
-- Permitir lectura anónima
create policy "Allow anonymous read access"
on documents for select
to anon
using (true);

-- Permitir inserción con service role
create policy "Allow service role insert"
on documents for insert
to service_role
using (true);
```

### Para el storage:
```sql
-- Permitir lectura con URL firmada
create policy "Allow authenticated read access"
on storage.objects for select
to authenticated
using (bucket_id = 'wedding-documents');
```

## 5. Variables de entorno

Agrega estas variables a tu archivo `.env`:

```
SUPABASE_URL=tu_url_de_supabase
SUPABASE_ANON_KEY=tu_anon_key
SUPABASE_SERVICE_KEY=tu_service_role_key
```

Nota: El service role key tiene permisos completos, mantenlo seguro.
