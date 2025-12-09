import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
dotenv.config();

// Importa tu sistema beta y el procesador de PDFs
import { AgenticRAGSystem } from './rag-chat.js';
import pdfProcessor from './pdf-processor.js';

// Configuración de WhatsApp
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_CLOUD_NUMBER_ID = process.env.WHATSAPP_CLOUD_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PORT = process.env.WHATSAPP_PORT || 5000;

if (!WHATSAPP_API_TOKEN || !WHATSAPP_CLOUD_NUMBER_ID || !WEBHOOK_VERIFY_TOKEN) {
    throw new Error("Faltan variables de entorno necesarias para WhatsApp");
}

// Directorio temporal para archivos descargados
const tempDir = path.join(os.tmpdir(), 'whatsapp_downloads');

// Clase para manejar la API de WhatsApp
class WhatsAppClient {
    constructor() {
        this.API_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_CLOUD_NUMBER_ID}`;
        this.headers = {
            'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
            'Content-Type': 'application/json'
        };
    }

    async sendTextMessage(message, phoneNumber) {
        const payload = {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'text',
            text: {
                preview_url: false,
                body: message
            }
        };

        try {
            const response = await fetch(`${this.API_URL}/messages`, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Error enviando mensaje: ${response.statusText} - ${errorText}`);
            }

            console.log('Mensaje enviado correctamente');
            return response.json();
        } catch (error) {
            console.error('Error al enviar mensaje:', error);
            throw error;
        }
    }

    // Extraer ID de archivo de Google Drive desde diferentes formatos de URL
    extractGoogleDriveFileId(url) {
        console.log(`Extrayendo ID de Google Drive desde: ${url}`);

        let fileId = null;

        // Formato: /file/d/{fileId}/view o /file/d/{fileId}/edit
        if (url.includes('/file/d/')) {
            const parts = url.split('/file/d/');
            if (parts.length > 1) {
                // Tomar el ID y eliminar todo después del primer /
                fileId = parts[1].split('/')[0];
            }
        }
        // Formato: ?id={fileId}
        else if (url.includes('id=')) {
            fileId = url.split('id=')[1].split('&')[0];
        }
        // Formato: /open?id={fileId}
        else if (url.includes('/open?')) {
            const params = new URL(url).searchParams;
            fileId = params.get('id');
        }

        // Limpiar el ID (eliminar espacios, etc.)
        if (fileId) {
            fileId = fileId.trim();
            console.log(`ID de Google Drive extraído: ${fileId}`);
        } else {
            console.log(`No se pudo extraer ID de Google Drive desde: ${url}`);
        }

        return fileId;
    }

    // Método específico para descargar archivos de Google Drive
    async downloadGoogleDriveFile(fileId) {
        try {
            console.log(`Descargando archivo de Google Drive con ID: ${fileId}`);

            // URL directa de descarga para Google Drive
            const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

            // Si es un archivo grande, Google Drive puede mostrar una pantalla de confirmación
            // Primero haremos una solicitud para obtener cookies
            const cookieJar = {};

            // Primera solicitud para obtener cookies/tokens
            const response1 = await axios.get(driveUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                maxRedirects: 5,
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // Acepta también redirecciones
                },
                timeout: 30000
            });

            // Guardar cookies (especialmente importante para archivos grandes)
            if (response1.headers['set-cookie']) {
                response1.headers['set-cookie'].forEach(cookie => {
                    const [name, value] = cookie.split('=');
                    if (name && value) {
                        cookieJar[name] = value.split(';')[0];
                    }
                });
            }

            console.log('Cookies obtenidas:', cookieJar);

            // Verificar si hay un formulario de confirmación (archivos grandes)
            let downloadUrl = driveUrl;
            let isLargeFile = false;

            if (response1.data && typeof response1.data === 'string') {
                if (response1.data.includes('confirm=')) {
                    const confirmMatch = response1.data.match(/confirm=([0-9A-Za-z]+)/);
                    if (confirmMatch && confirmMatch[1]) {
                        downloadUrl = `https://drive.google.com/uc?export=download&confirm=${confirmMatch[1]}&id=${fileId}`;
                        isLargeFile = true;
                        console.log(`Detectado archivo grande, usando URL de confirmación: ${downloadUrl}`);
                    }
                }

                // También revisar mensajes de error
                if (response1.data.includes('No puede acceder a este elemento')) {
                    throw new Error('No tienes permiso para acceder a este archivo. Verifica que el archivo esté compartido con "Cualquier persona con el enlace"');
                }

                if (response1.data.includes('El archivo solicitado no existe')) {
                    throw new Error('El archivo no existe o ha sido eliminado de Google Drive');
                }
            }

            // Construir string de cookies
            let cookieString = '';
            for (const [name, value] of Object.entries(cookieJar)) {
                cookieString += `${name}=${value}; `;
            }

            // Segunda solicitud para descargar el archivo
            const response2 = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Cookie': cookieString
                },
                maxRedirects: 5,
                timeout: 60000 // Timeout más largo para archivos grandes
            });

            // Verificar el tipo de contenido
            const contentType = response2.headers['content-type'];
            console.log(`Tipo de contenido recibido: ${contentType}`);

            // Guardar una copia del archivo para depuración
            const debugFilePath = path.join(tempDir, `google_drive_${fileId}_debug.bin`);
            await fs.writeFile(debugFilePath, Buffer.from(response2.data));
            console.log(`Archivo de depuración guardado en: ${debugFilePath}`);

            // Verificar que sea un PDF examinando los bytes iniciales
            const buffer = Buffer.from(response2.data);

            // Verificar el tamaño del archivo
            console.log(`Tamaño del archivo descargado: ${buffer.length} bytes`);
            if (buffer.length === 0) {
                throw new Error('El archivo descargado está vacío');
            }

            // Los PDF válidos comienzan con %PDF-
            if (buffer.length >= 5) {
                const signature = buffer.toString('ascii', 0, 5);
                console.log(`Firma del archivo: ${signature}`);

                if (signature === '%PDF-') {
                    console.log('El archivo tiene una firma de PDF válida');
                    return buffer;
                }
            }

            // Si llegamos aquí y el tipo de contenido es HTML, probablemente tenemos una página de error
            if (contentType && contentType.includes('text/html')) {
                // Extraer mensaje de error si está en formato HTML
                const htmlContent = buffer.toString('utf8').substring(0, 1000);
                console.log(`Contenido HTML recibido (primeros 1000 caracteres): ${htmlContent}`);

                if (htmlContent.includes('Error 404')) {
                    throw new Error('El archivo no existe o ha sido eliminado de Google Drive');
                }

                if (htmlContent.includes('No tienes permiso')) {
                    throw new Error('No tienes permiso para acceder a este archivo. Verifica que el archivo esté compartido con "Cualquier persona con el enlace"');
                }

                // Si es un archivo grande, podríamos estar en la página de confirmación
                if (htmlContent.includes('Descargar de todos modos') || htmlContent.includes('Download anyway')) {
                    throw new Error('Este es un archivo grande y requiere confirmación manual. Por favor, descarga el archivo manualmente y súbelo a otro servicio como Dropbox o un servidor web simple.');
                }
            }

            // Intentar una tercera estrategia: usar la API de exportación de Google Drive
            if (isLargeFile) {
                console.log('Intentando estrategia alternativa para archivos grandes...');
                // Construir una URL de descarga directa alternativa
                const alternativeUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

                // Nota: Esta URL requiere autenticación con OAuth, no implementada aquí
                // Solo mostramos el mensaje informativo
                throw new Error('Este archivo de Google Drive es demasiado grande para ser descargado automáticamente. Por favor, descárgalo manualmente y súbelo a otro servicio como Dropbox o un servidor web simple.');
            }

            throw new Error(`El archivo descargado no es un PDF válido (tipo: ${contentType})`);
        } catch (error) {
            console.error('Error al descargar archivo de Google Drive:', error.message);
            throw error;
        }
    }
}

// Crear aplicación Express
const app = express();
app.use(express.json());

// Inicializar cliente de WhatsApp
const whatsappClient = new WhatsAppClient();

// Inicializar tu sistema RAG
const agenticRAG = new AgenticRAGSystem();

// Inicializar el vector store al arrancar
(async () => {
    try {
        // Crear directorio temporal si no existe
        await fs.mkdir(tempDir, { recursive: true });

        // Inicializar vector store para el RAG
        await agenticRAG.initVectorStore();

        // Inicializar processor de PDFs
        await pdfProcessor.initVectorStore();

        console.log("WhatsApp Bot iniciado y vector stores inicializados.");

        // Notificar al proceso principal que el bot está listo
        if (process.send) {
            process.send('ready');
        }
    } catch (error) {
        console.error("Error inicializando:", error);
        process.exit(1);
    }
})();

// Ruta principal
app.get('/', (req, res) => {
    res.send('<h1>WhatsApp Bot con RAG está funcionando</h1>');
});

// Webhook de WhatsApp
app.get('/webhook', (req, res) => {
    // Verificación del webhook
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verificado exitosamente');
        res.status(200).send(challenge);
    } else {
        console.error('Verificación de webhook fallida');
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        // WhatsApp requiere una respuesta 200 INMEDIATA para confirmar la recepción
        // Enviamos la respuesta de inmediato y procesamos el mensaje en segundo plano
        res.sendStatus(200);

        const data = req.body;
        console.log('Datos del webhook entrante:', JSON.stringify(data, null, 2));

        // Extraer el mensaje
        const entry = data.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
            console.log('No hay mensajes para procesar');
            return;
        }

        const message = messages[0];
        const senderPhone = message.from;

        if (!senderPhone) {
            console.log('Número de teléfono de remitente no encontrado');
            return;
        }

        // Procesar mensajes de texto
        if (message.type === 'text') {
            const text = message.text?.body;

            if (!text) {
                console.log('Texto del mensaje no encontrado');
                return;
            }

            console.log(`Mensaje recibido de ${senderPhone}: ${text}`);

            // Verificar si es el mensaje de bienvenida
            if (text.trim().toLowerCase() === 'hola' || text.trim().toLowerCase() === 'start') {
                const welcomeMessage = "¡Bienvenido a Chettry. ¡Pregúntame lo que quieras!\n\nTambién puedes compartir enlaces a PDFs usando el formato: \"pdf: URL_DEL_PDF\"\n\nPara Google Drive: debes compartir el archivo con 'Cualquier persona con el enlace' y enviarme el enlace completo.";
                await whatsappClient.sendTextMessage(welcomeMessage, senderPhone);
            }
            // Verificar si es un enlace a un PDF o un enlace a Google Drive
            else if (text.trim().toLowerCase().startsWith('pdf:') ||
                (text.includes('drive.google.com') &&
                    (text.includes('/file/d/') || text.includes('id=') || text.includes('/open?'))) ||
                (text.includes('.pdf') && text.includes('http'))) {

                let pdfUrl = text;
                if (text.trim().toLowerCase().startsWith('pdf:')) {
                    pdfUrl = text.trim().substring(4).trim();
                }

                if (!pdfUrl || !pdfUrl.includes('http')) {
                    await whatsappClient.sendTextMessage("Por favor, proporciona una URL válida. Por ejemplo: pdf: https://drive.google.com/file/d/abc123/view", senderPhone);
                    return;
                }

                try {
                    await whatsappClient.sendTextMessage(`📝 Analizando el enlace: ${pdfUrl}...`, senderPhone);

                    // Verificar si es un enlace de Google Drive
                    if (pdfUrl.includes('drive.google.com')) {
                        const fileId = whatsappClient.extractGoogleDriveFileId(pdfUrl);

                        if (!fileId) {
                            await whatsappClient.sendTextMessage("❌ No se pudo extraer el ID del archivo de Google Drive. Asegúrate de compartir un enlace con formato correcto de Google Drive.", senderPhone);
                            return;
                        }

                        // Comprobar permiso de archivo
                        await whatsappClient.sendTextMessage("⚠️ Para que pueda acceder al PDF, asegúrate de que el archivo esté compartido con la opción 'Cualquier persona con el enlace' en Google Drive.", senderPhone);

                        // Descargar archivo
                        await whatsappClient.sendTextMessage("⏳ Descargando el PDF de Google Drive. Esto puede tomar hasta 30 segundos...", senderPhone);

                        try {
                            const pdfBuffer = await whatsappClient.downloadGoogleDriveFile(fileId);

                            if (!pdfBuffer || pdfBuffer.length === 0) {
                                await whatsappClient.sendTextMessage("❌ No se pudo descargar el PDF. El archivo podría estar vacío, no ser accesible o no cumplir con los requisitos de permisos.", senderPhone);
                                return;
                            }

                            await whatsappClient.sendTextMessage(`✅ PDF descargado correctamente (${Math.round(pdfBuffer.length / 1024)} KB). Procesando...`, senderPhone);

                            // Generar un nombre para el archivo
                            const fileName = `gdrive_${fileId}.pdf`;

                            // Procesar el PDF
                            await whatsappClient.sendTextMessage("⏳ Analizando el contenido del PDF e indexándolo. Esto tomará un momento...", senderPhone);

                            try {
                                const result = await pdfProcessor.processPDF(pdfBuffer, fileName);

                                if (result.success) {
                                    await whatsappClient.sendTextMessage(
                                        `✅ ¡PDF procesado con éxito!\n\n${result.message}\n\nAhora puedes hacerme preguntas sobre el contenido de este documento.`,
                                        senderPhone
                                    );
                                } else {
                                    await whatsappClient.sendTextMessage(
                                        `❌ Error al procesar el PDF: ${result.message}`,
                                        senderPhone
                                    );
                                }
                            } catch (processingError) {
                                console.error("Error en el procesamiento del PDF:", processingError);
                                await whatsappClient.sendTextMessage(
                                    `❌ Error al procesar el documento: ${processingError.message}. Verifica que sea un PDF válido.`,
                                    senderPhone
                                );
                            }
                        } catch (downloadError) {
                            console.error("Error al descargar el archivo de Google Drive:", downloadError);
                            await whatsappClient.sendTextMessage(
                                `❌ Error al descargar el archivo: ${downloadError.message}`,
                                senderPhone
                            );
                        }
                    } else {
                        // Para otros URLs (no Google Drive), implemetar código aquí
                        await whatsappClient.sendTextMessage(
                            "Actualmente solo se admiten enlaces de Google Drive. Por favor, sube tu PDF a Google Drive y comparte el enlace.",
                            senderPhone
                        );
                    }
                } catch (error) {
                    console.error("Error procesando URL de PDF:", error);
                    await whatsappClient.sendTextMessage(`❌ Error al procesar la URL: ${error.message}`, senderPhone);
                }
            }
            else {
                // Procesar la consulta con tu sistema RAG
                try {
                    const response = await agenticRAG.processQuery(text);
                    await whatsappClient.sendTextMessage(response.answer, senderPhone);
                } catch (err) {
                    console.error("Error procesando la consulta:", err);
                    await whatsappClient.sendTextMessage("Ocurrió un error al procesar tu consulta.", senderPhone);
                }
            }
        }
        // Procesar documentos (PDFs)
        else if (message.type === 'document') {
            if (!message.document) {
                console.log('Datos del documento no encontrados');
                return;
            }

            const document = message.document;
            const fileName = document.filename || `documento_${Date.now()}.pdf`;

            // Informar al usuario sobre las limitaciones actuales de procesamiento directo
            await whatsappClient.sendTextMessage(
                `Lo siento, actualmente la API de WhatsApp tiene restricciones para la descarga directa de documentos.\n\nPuedes subir tu PDF "${fileName}" a Google Drive, compartirlo con la opción "Cualquier persona con el enlace" y enviarme el enlace.`,
                senderPhone
            );
        }
        // Si se recibe audio
        else if (message.type === 'audio' || message.type === 'voice') {
            await whatsappClient.sendTextMessage("Lo siento, aún no soporto entrada de audio.", senderPhone);
        }
        // Si se recibe una imagen
        else if (message.type === 'image') {
            await whatsappClient.sendTextMessage("Lo siento, la funcionalidad para procesar imágenes aún no está implementada.", senderPhone);
        } else {
            console.log(`Tipo de mensaje no soportado: ${message.type}`);
        }
    } catch (error) {
        console.error('Error procesando webhook:', error);
    }
});

// Ruta adicional para probar el envío de mensajes
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Se requiere phone y message' });
    }

    try {
        const result = await whatsappClient.sendTextMessage(message, phone);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Iniciar servidor
const server = app.listen(PORT, () => {
    console.log(`Servidor de WhatsApp ejecutándose en puerto ${PORT}`);
});

// Manejo de cierre
process.on('SIGINT', () => {
    server.close();
    console.log('Servidor de WhatsApp detenido');
    process.exit(0);
});

process.on('SIGTERM', () => {
    server.close();
    console.log('Servidor de WhatsApp detenido');
    process.exit(0);
});

// Exportar para que el archivo pueda ser usado como módulo
export default app;