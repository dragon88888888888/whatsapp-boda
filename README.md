# ChatMistery Bot

ChatMistery Bot es un bot de chat basado en inteligencia artificial que utiliza un sistema de Recuperación-Augmented Generation (RAG) para responder consultas sobre misticismo y sabiduría. El bot combina respuestas generadas a partir de textos clásicos con sugerencias de videos de YouTube para ofrecer una experiencia interactiva tanto en Telegram como en WhatsApp.

## Características

- **Respuestas Inteligentes**: Utiliza un sistema RAG con el modelo Gemini-2.0 Flash para generar respuestas contextualizadas.
- **Recomendación de Videos**: Extrae palabras clave de la respuesta para sugerir videos relevantes de YouTube.
- **Integración Multi-Plataforma**: Funciona tanto en Telegram como en WhatsApp.
- **Procesamiento de PDFs**: Permite a los usuarios subir documentos PDF para expandir la base de conocimiento.
- **Gestión de Conversación**: Mantiene un historial para ofrecer respuestas coherentes y contextuales.

## Requisitos

- Node.js (v14 o superior)
- Cuenta en Pinecone para vectorstore
- Cuenta en Google Cloud Platform para APIs
- Cuenta de desarrollador de Telegram
- Cuenta de desarrollador de WhatsApp Business

## Guía de configuración

### 1. Configuración de APIs y servicios externos

#### Google Cloud Platform
1. Crea una cuenta en [Google Cloud Platform](https://console.cloud.google.com/)
2. Crea un nuevo proyecto
3. Habilita las siguientes APIs:
   - Google AI Gemini API
   - YouTube Data API v3
4. Crea credenciales de API y obtén tu `GOOGLE_API_KEY` y `YOUTUBE_API_KEY`

#### Pinecone
1. Crea una cuenta en [Pinecone](https://www.pinecone.io/)
2. Crea un nuevo índice con dimensión 768 y métrica cosine
3. Obtén tu `PINECONE_API_KEY`, `PINECONE_ENVIRONMENT` y nombre del `PINECONE_INDEX`

#### Telegram
1. Habla con [@BotFather](https://t.me/BotFather) en Telegram
2. Envía `/newbot` y sigue las instrucciones
3. Guarda el token API proporcionado como `TELEGRAM_BOT_TOKEN`

#### WhatsApp Business
1. Crea una cuenta en [Facebook Developers](https://developers.facebook.com/)
2. Configura una aplicación de WhatsApp Business
3. Configura un número de teléfono para pruebas
4. Obtén el `WHATSAPP_API_TOKEN` y el `WHATSAPP_CLOUD_NUMBER_ID`
5. Crea un `WEBHOOK_VERIFY_TOKEN` personalizado (cualquier cadena segura)

### 2. Instalación

1. Clona el repositorio:
   ```sh
   git clone https://github.com/dragon88888888888/chatRAG-mistisismo.git
   cd chatRAG-mistisismo
   ```

2. Instala las dependencias:
   ```sh
   npm install
   ```

3. Crea un archivo `.env` basado en `.env.example`:
   ```sh
   cp .env.example .env
   ```

4. Completa todas las variables en el archivo `.env` con tus credenciales:
   ```
   GOOGLE_API_KEY=tu_clave_api_google
   TAVILY_API_KEY=tu_clave_api_tavily
   TOGETHER_AI_API_KEY=tu_clave_api_together
   PINECONE_API_KEY=tu_clave_api_pinecone
   PINECONE_ENVIRONMENT=tu_entorno_pinecone
   PINECONE_INDEX=tu_indice_pinecone
   YOUTUBE_API_KEY=tu_clave_api_youtube
   YOUTUBE_CHANNEL_ID=id_canal_youtube_para_recomendaciones
   TELEGRAM_BOT_TOKEN=tu_token_bot_telegram
   
   # Configuración de WhatsApp
   WHATSAPP_API_TOKEN=tu_token_api_whatsapp
   WHATSAPP_CLOUD_NUMBER_ID=tu_id_numero_whatsapp
   WEBHOOK_VERIFY_TOKEN=tu_token_verificacion
   ```

### 3. Preparación de la base de conocimientos

#### Opción 1: Usar libros predeterminados
1. Crea una carpeta llamada `arcanos` en la raíz del proyecto
2. Coloca tus archivos PDF de misticismo/sabiduría en esta carpeta
3. Ejecuta el indexador para cargar los documentos en Pinecone:
   ```sh
   node document-index.js
   ```

#### Opción 2: Añadir documentos a través del bot
Una vez que el bot esté en funcionamiento, puedes enviarle archivos PDF directamente a través de Telegram o compartir enlaces de Google Drive a través de WhatsApp.

### 4. Configuración del webhook para WhatsApp

1. Necesitarás un servidor con HTTPS accesible públicamente. Puedes usar servicios como:
   - [ngrok](https://ngrok.com/) para desarrollo
   - Un VPS con dominio y certificado SSL para producción

2. Si utilizas ngrok para desarrollo:
   ```sh
   ngrok http 5000
   ```

3. Registra la URL del webhook en el panel de WhatsApp Business API:
   - URL: `https://tu-dominio.com/webhook` o la URL proporcionada por ngrok
   - Token de verificación: el mismo que configuraste en `WEBHOOK_VERIFY_TOKEN`

### 5. Ejecución del bot

#### Desarrollo (un solo bot)
Para Telegram:
```sh
node chattelegram.js
```

Para WhatsApp:
```sh
node chatwhats.js
```

#### Producción (ambos bots)
```sh
node index.js
```

O para mantener el servicio activo:
```sh
npm install -g pm2
pm2 start index.js --name "chatmistery"
```

## Uso

### Telegram
1. Busca tu bot por su nombre de usuario en Telegram
2. Inicia la conversación con `/start`
3. Haz preguntas sobre misticismo o sabiduría
4. Envía archivos PDF para expandir el conocimiento del bot

### WhatsApp
1. Envía un mensaje al número configurado
2. Escribe "hola" o "start" para recibir un mensaje de bienvenida
3. Haz preguntas sobre misticismo o sabiduría
4. Comparte enlaces a PDFs en Google Drive escribiendo "pdf: URL_DEL_PDF"
   - Asegúrate de compartir el archivo con "Cualquier persona con el enlace"

## Limitaciones y solución de problemas

- **Archivos en WhatsApp**: Actualmente, WhatsApp tiene restricciones para la descarga directa de documentos. Por eso se recomienda usar Google Drive como intermediario.
- **Límite de tamaño de PDFs**: Se recomienda usar archivos PDF de menos de 10MB para mejor rendimiento.
- **Errores de conexión**: Si hay problemas con Pinecone, verifica que estés dentro de los límites de la capa gratuita o considera actualizar tu plan.
- **Problemas con la API de WhatsApp**: Si el bot no responde en WhatsApp, verifica que el webhook esté correctamente configurado.

## Contribución

¡Las contribuciones son bienvenidas! Si deseas mejorar el bot o agregar nuevas funcionalidades:

1. Haz un fork del repositorio
2. Crea una nueva rama (`git checkout -b feature/nueva-funcionalidad`)
3. Realiza tus cambios y haz commit (`git commit -am 'Añade nueva funcionalidad'`)
4. Sube los cambios a tu fork (`git push origin feature/nueva-funcionalidad`)
5. Crea un Pull Request

## Licencia

Este proyecto se distribuye bajo la licencia MIT. Ver archivo [LICENSE](LICENSE) para más detalles.