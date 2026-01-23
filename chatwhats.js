import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
dotenv.config();

import { AgenticRAGSystem } from './rag-chat.js';

const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_CLOUD_NUMBER_ID = process.env.WHATSAPP_CLOUD_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PORT = process.env.WHATSAPP_PORT || 5000;

if (!WHATSAPP_API_TOKEN || !WHATSAPP_CLOUD_NUMBER_ID || !WEBHOOK_VERIFY_TOKEN) {
    throw new Error("Faltan variables de entorno necesarias para WhatsApp");
}

const tempDir = path.join(os.tmpdir(), 'whatsapp_wedding');

class WhatsAppClient {
    constructor() {
        this.API_URL = `https://graph.facebook.com/v24.0/${WHATSAPP_CLOUD_NUMBER_ID}`;
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
                preview_url: true,
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

    async sendDocument(phoneNumber, fileUrl, fileName, caption = '') {
        const payload = {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'document',
            document: {
                link: fileUrl,
                filename: fileName,
                caption: caption
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
                throw new Error(`Error enviando documento: ${response.statusText} - ${errorText}`);
            }

            console.log('Documento enviado correctamente');
            return response.json();
        } catch (error) {
            console.error('Error al enviar documento:', error);
            throw error;
        }
    }
}

const app = express();
app.use(express.json());

const whatsappClient = new WhatsAppClient();
const agenticRAG = new AgenticRAGSystem();

let initialized = false;

async function initializeBot() {
    if (initialized) return;

    try {
        console.log("Inicializando bot...");
        await fs.mkdir(tempDir, { recursive: true });
        await agenticRAG.initVectorStore();
        await agenticRAG.initMCPTools();
        console.log("WhatsApp Bot iniciado, vector store y MCP tools inicializados.");
        initialized = true;

        if (process.send) {
            process.send('ready');
        }
    } catch (error) {
        console.error("Error inicializando:", error);
        if (process.env.NODE_ENV !== 'production') {
            process.exit(1);
        }
        throw error;
    }
}

if (process.env.NODE_ENV !== 'production') {
    await initializeBot();
}

app.get('/', (req, res) => {
    res.send('<h1>WhatsApp Bot - Agente de Viajes</h1>');
});

app.get('/webhook', async (req, res) => {
    await initializeBot();

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
        await initializeBot();

        console.log('========== WEBHOOK POST RECIBIDO ==========');
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('==========================================');

        res.sendStatus(200);

        const data = req.body;
        console.log('Datos del webhook entrante:', JSON.stringify(data, null, 2));

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

        if (message.type === 'text') {
            const text = message.text?.body;

            if (!text) {
                console.log('Texto del mensaje no encontrado');
                return;
            }

            console.log(`Mensaje recibido de ${senderPhone}: ${text}`);

            // Mensaje de bienvenida
            if (text.trim().toLowerCase() === 'hola' || text.trim().toLowerCase() === 'start') {
                const welcomeMessage = `Bienvenido a tu agente de viajes virtual.

Estoy aqui para ayudarte con toda la informacion sobre tus viajes.

Puedes preguntarme sobre:
- Destinos y recomendaciones
- Horarios de vuelos y trenes
- Hoteles y alojamientos
- Tours y actividades
- Documentacion de viaje

Tambien puedo enviarte documentos como boletos, reservas, itinerarios, etc.

En que puedo ayudarte?`;
                await whatsappClient.sendTextMessage(welcomeMessage, senderPhone);
            }
            else {
                try {
                    // Procesar la consulta con el sistema RAG
                    const response = await agenticRAG.processQuery(text, senderPhone);

                    // Enviar la respuesta principal
                    await whatsappClient.sendTextMessage(response.answer, senderPhone);

                    // Si hay archivos descargados, enviarlos
                    if (response.downloadedFiles && response.downloadedFiles.length > 0) {
                        console.log(`Enviando ${response.downloadedFiles.length} documento(s)...`);

                        try {
                            const files = response.downloadedFiles;

                            // Enviar los primeros 3 PDFs encontrados
                            const maxPDFs = Math.min(files.length, 3);
                            for (let i = 0; i < maxPDFs; i++) {
                                const file = files[i];
                                try {
                                    await whatsappClient.sendDocument(
                                        senderPhone,
                                        file.url,
                                        file.name,
                                        ''
                                    );
                                    console.log(`✓ PDF enviado: ${file.name}`);
                                } catch (sendError) {
                                    console.error(`Error enviando PDF ${file.name}:`, sendError);
                                    await whatsappClient.sendTextMessage(
                                        `No pude enviar el documento "${file.name}". Intenta de nuevo más tarde.`,
                                        senderPhone
                                    );
                                }

                                // Pequeña pausa entre documentos
                                await new Promise(resolve => setTimeout(resolve, 1500));
                            }

                            if (files.length > 3) {
                                await whatsappClient.sendTextMessage(
                                    `Tengo ${files.length - 3} documento(s) adicional(es). ¿Quieres que te los envíe también?`,
                                    senderPhone
                                );
                            }
                        } catch (pdfError) {
                            console.error("Error enviando documentos:", pdfError);
                            await whatsappClient.sendTextMessage(
                                `Hubo un error al enviar los documentos. Por favor, intenta de nuevo.`,
                                senderPhone
                            );
                        }
                    }
                } catch (err) {
                    console.error("Error procesando la consulta:", err);
                    await whatsappClient.sendTextMessage(
                        "Ocurrió un error al procesar tu consulta. Por favor, intenta de nuevo.",
                        senderPhone
                    );
                }
            }
        }
        else if (message.type === 'document') {
            await whatsappClient.sendTextMessage(
                "Gracias por el documento. Actualmente no proceso documentos nuevos, pero puedo ayudarte con tu itinerario de viaje.",
                senderPhone
            );
        }
        else if (message.type === 'audio' || message.type === 'voice') {
            await whatsappClient.sendTextMessage(
                "Lo siento, aún no soporto entrada de audio.",
                senderPhone
            );
        }
        else if (message.type === 'image') {
            await whatsappClient.sendTextMessage(
                "Lo siento, la funcionalidad para procesar imágenes aún no está implementada.",
                senderPhone
            );
        } else {
            console.log(`Tipo de mensaje no soportado: ${message.type}`);
        }
    } catch (error) {
        console.error('Error procesando webhook:', error);
    }
});

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

if (process.env.NODE_ENV !== 'production') {
    const server = app.listen(PORT, () => {
        console.log(`Servidor de WhatsApp ejecutándose en puerto ${PORT}`);
    });

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
}

export default app;
