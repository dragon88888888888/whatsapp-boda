import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
dotenv.config();

import { AgenticRAGSystem } from './rag-chat.js';
import { PDFStorage } from './pdf-storage.js';

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
const pdfStorage = new PDFStorage();

(async () => {
    try {
        await fs.mkdir(tempDir, { recursive: true });
        await agenticRAG.initVectorStore();
        await agenticRAG.initMCPAgent();
        console.log("WhatsApp Bot iniciado, vector store y MCP agent inicializados.");

        if (process.send) {
            process.send('ready');
        }
    } catch (error) {
        console.error("Error inicializando:", error);
        process.exit(1);
    }
})();

app.get('/', (req, res) => {
    res.send('<h1>WhatsApp Bot - Asistente de Viaje</h1>');
});

app.get('/webhook', (req, res) => {
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
                const welcomeMessage = `¡Bienvenidos Miguel y Vero a su asistente de viaje!

Estoy aquí para ayudarlos con su itinerario de luna de miel por Europa.

Pueden preguntarme sobre:
- Horarios de vuelos y trenes
- Direcciones de hoteles
- Detalles de tours y actividades
- Información general del itinerario

También puedo enviarles documentos específicos como boletos, reservas de hotel, etc.

¿En qué puedo ayudarlos?`;
                await whatsappClient.sendTextMessage(welcomeMessage, senderPhone);
            }
            else {
                try {
                    // Procesar la consulta con el sistema RAG
                    const response = await agenticRAG.processQuery(text, senderPhone);

                    // Enviar la respuesta principal
                    await whatsappClient.sendTextMessage(response.answer, senderPhone);

                    // Si se detectó una solicitud de PDF y se encontraron documentos
                    if (response.pdfResult) {
                        console.log(`Solicitud de PDF procesada: ${response.pdfRequest}`);

                        try {
                            if (response.pdfResult.found && response.pdfResult.files.length > 0) {
                                const pdfs = response.pdfResult.files;

                                await whatsappClient.sendTextMessage(
                                    `${response.pdfResult.message}. Enviando...`,
                                    senderPhone
                                );

                                // Enviar los primeros 3 PDFs encontrados
                                const maxPDFs = Math.min(pdfs.length, 3);
                                for (let i = 0; i < maxPDFs; i++) {
                                    const pdf = pdfs[i];
                                    try {
                                        await whatsappClient.sendDocument(
                                            senderPhone,
                                            pdf.downloadUrl,
                                            pdf.name,
                                            pdf.description || pdf.category || ''
                                        );
                                        console.log(`PDF enviado: ${pdf.name}`);
                                    } catch (sendError) {
                                        console.error(`Error enviando PDF ${pdf.name}:`, sendError);
                                        await whatsappClient.sendTextMessage(
                                            `No pude enviar el documento "${pdf.name}". Intenta de nuevo más tarde.`,
                                            senderPhone
                                        );
                                    }

                                    // Pequeña pausa entre documentos
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                }

                                if (pdfs.length > 3) {
                                    await whatsappClient.sendTextMessage(
                                        `Se encontraron ${pdfs.length - 3} documento(s) adicional(es). ¿Quieres que te los envíe también?`,
                                        senderPhone
                                    );
                                }
                            } else {
                                await whatsappClient.sendTextMessage(
                                    response.pdfResult.message || `No encontré documentos relacionados. Puedes ser más específico o preguntarme sobre categorías como: boletos, hoteles, traslados, tours, trenes.`,
                                    senderPhone
                                );
                            }
                        } catch (pdfError) {
                            console.error("Error enviando PDF:", pdfError);
                            await whatsappClient.sendTextMessage(
                                `Hubo un error al enviar el documento. Por favor, intenta de nuevo.`,
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

export default app;
