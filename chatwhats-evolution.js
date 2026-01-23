import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
dotenv.config();

import { AgenticRAGSystem } from './rag-chat.js';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'tu-api-key-segura-aqui';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'wedding-bot';
const PORT = process.env.WHATSAPP_PORT || 5000;

const tempDir = path.join(os.tmpdir(), 'whatsapp_wedding');

let allowedNumbers = [];

async function loadAllowedNumbers() {
    try {
        const data = await fs.readFile('./allowed-numbers.json', 'utf-8');
        const config = JSON.parse(data);
        allowedNumbers = config.allowedNumbers || [];
        console.log(`Números permitidos cargados: ${allowedNumbers.length}`);
    } catch (error) {
        console.warn('No se pudo cargar allowed-numbers.json, permitiendo todos los números');
        allowedNumbers = [];
    }
}

function isNumberAllowed(phoneNumber) {
    if (allowedNumbers.length === 0) return true;

    const cleanNumber = phoneNumber.replace('@s.whatsapp.net', '').replace(/\D/g, '');

    return allowedNumbers.some(allowed => {
        const cleanAllowed = allowed.replace(/\D/g, '');
        return cleanNumber === cleanAllowed || cleanNumber.endsWith(cleanAllowed);
    });
}

class EvolutionAPIClient {
    constructor() {
        this.API_URL = EVOLUTION_API_URL;
        this.API_KEY = EVOLUTION_API_KEY;
        this.INSTANCE = EVOLUTION_INSTANCE;
        this.headers = {
            'apikey': this.API_KEY,
            'Content-Type': 'application/json'
        };
    }

    async sendTextMessage(message, phoneNumber) {
        const cleanNumber = phoneNumber.replace('@s.whatsapp.net', '');

        const payload = {
            number: cleanNumber,
            text: message
        };

        try {
            const response = await fetch(`${this.API_URL}/message/sendText/${this.INSTANCE}`, {
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
        const cleanNumber = phoneNumber.replace('@s.whatsapp.net', '');

        const payload = {
            number: cleanNumber,
            mediatype: 'document',
            media: fileUrl,
            fileName: fileName,
            caption: caption
        };

        try {
            const response = await fetch(`${this.API_URL}/message/sendMedia/${this.INSTANCE}`, {
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

const evolutionClient = new EvolutionAPIClient();
const agenticRAG = new AgenticRAGSystem();

let initialized = false;

async function initializeBot() {
    if (initialized) return;

    try {
        console.log("Inicializando bot...");
        await fs.mkdir(tempDir, { recursive: true });
        await loadAllowedNumbers();
        await agenticRAG.initVectorStore();
        await agenticRAG.initMCPTools();
        console.log("WhatsApp Bot iniciado, vector store y MCP tools inicializados.");
        initialized = true;

        if (process.send) {
            process.send('ready');
        }
    } catch (error) {
        console.error("Error inicializando:", error);
        throw error;
    }
}

await initializeBot();

app.get('/', (req, res) => {
    res.send('<h1>WhatsApp Bot - Agente de Viajes (Evolution API)</h1>');
});

app.post('/webhook', async (req, res) => {
    try {
        console.log('========== WEBHOOK POST RECIBIDO ==========');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('==========================================');

        res.sendStatus(200);

        const data = req.body;

        if (data.event !== 'messages.upsert') {
            console.log(`Evento ignorado: ${data.event}`);
            return;
        }

        const messageData = data.data;

        if (!messageData || messageData.key?.fromMe) {
            console.log('Mensaje propio, ignorando');
            return;
        }

        const senderPhone = messageData.key?.remoteJid;

        if (!senderPhone) {
            console.log('Número de teléfono de remitente no encontrado');
            return;
        }

        if (!isNumberAllowed(senderPhone)) {
            console.log(`Número no permitido: ${senderPhone} - ignorando mensaje`);
            return;
        }

        const messageType = messageData.messageType;
        let text = '';

        if (messageType === 'conversation') {
            text = messageData.message?.conversation;
        } else if (messageType === 'extendedTextMessage') {
            text = messageData.message?.extendedTextMessage?.text;
        } else if (messageType === 'imageMessage') {
            text = messageData.message?.imageMessage?.caption || '';
        }

        if (!text) {
            console.log('Texto del mensaje no encontrado o tipo no soportado');
            return;
        }

        console.log(`Mensaje recibido de ${senderPhone}: ${text}`);

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
            await evolutionClient.sendTextMessage(welcomeMessage, senderPhone);
        }
        else {
            try {
                const response = await agenticRAG.processQuery(text, senderPhone);

                await evolutionClient.sendTextMessage(response.answer, senderPhone);

                if (response.downloadedFiles && response.downloadedFiles.length > 0) {
                    console.log(`Enviando ${response.downloadedFiles.length} documento(s)...`);

                    try {
                        const files = response.downloadedFiles;

                        const maxPDFs = Math.min(files.length, 3);
                        for (let i = 0; i < maxPDFs; i++) {
                            const file = files[i];
                            try {
                                await evolutionClient.sendDocument(
                                    senderPhone,
                                    file.url,
                                    file.name,
                                    ''
                                );
                                console.log(`✓ PDF enviado: ${file.name}`);
                            } catch (sendError) {
                                console.error(`Error enviando PDF ${file.name}:`, sendError);
                                await evolutionClient.sendTextMessage(
                                    `No pude enviar el documento "${file.name}". Intenta de nuevo más tarde.`,
                                    senderPhone
                                );
                            }

                            await new Promise(resolve => setTimeout(resolve, 1500));
                        }

                        if (files.length > 3) {
                            await evolutionClient.sendTextMessage(
                                `Tengo ${files.length - 3} documento(s) adicional(es). ¿Quieres que te los envíe también?`,
                                senderPhone
                            );
                        }
                    } catch (pdfError) {
                        console.error("Error enviando documentos:", pdfError);
                        await evolutionClient.sendTextMessage(
                            `Hubo un error al enviar los documentos. Por favor, intenta de nuevo.`,
                            senderPhone
                        );
                    }
                }
            } catch (err) {
                console.error("Error procesando la consulta:", err);
                await evolutionClient.sendTextMessage(
                    "Ocurrió un error al procesar tu consulta. Por favor, intenta de nuevo.",
                    senderPhone
                );
            }
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
        const result = await evolutionClient.sendTextMessage(message, phone);
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
