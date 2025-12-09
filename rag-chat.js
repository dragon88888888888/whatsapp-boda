import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
}

import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import dotenv from "dotenv";
import { PDFStorage } from './pdf-storage.js';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

class AgenticRAGSystem {
    constructor() {
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        this.embeddings = new OpenAIEmbeddings({
            modelName: "text-embedding-3-small",
            openAIApiKey: process.env.OPENAI_API_KEY,
        });

        this.pdfStorage = new PDFStorage();
        this.sessionId = uuidv4();
        this.conversationHistory = "";
        this.downloadsDir = './downloads';
        this.mcpClient = null;
        this.agent = null;
        this.model = new ChatOpenAI({
            modelName: "gpt-4o-mini",
            temperature: 0.7,
            maxTokens: 2048,
            openAIApiKey: process.env.OPENAI_API_KEY,
        });
    }

    async initVectorStore() {
        this.vectorStore = await SupabaseVectorStore.fromExistingIndex(
            this.embeddings,
            {
                client: this.supabase,
                tableName: "documents",
                queryName: "match_documents",
            }
        );
        return this.vectorStore;
    }

    async initMCPAgent() {
        try {
            // Crear tools personalizadas
            const getCurrentDateTool = tool(
                () => {
                    const now = new Date();
                    const dateOptions = {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        timeZone: 'Europe/Paris'
                    };
                    const timeOptions = {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'Europe/Paris',
                        timeZoneName: 'short'
                    };
                    const dateStr = now.toLocaleDateString('es-ES', dateOptions);
                    const timeStr = now.toLocaleTimeString('es-ES', timeOptions);
                    return `${dateStr}, ${timeStr}`;
                },
                {
                    name: "obtener_fecha_actual",
                    description: "Obtiene la fecha y hora actual en zona horaria de Europa Central (CET/CEST). Úsala cuando el usuario pregunte qué día es hoy, qué hora es, o necesites saber la fecha actual.",
                    schema: z.object({})
                }
            );

            const searchRAGTool = tool(
                async ({ pregunta }) => {
                    const retriever = this.vectorStore.asRetriever({ k: 5 });
                    const docs = await retriever.invoke(pregunta);
                    const context = docs.map(doc => doc.pageContent).join('\n\n');

                    const prompt = `Basándote en el siguiente contexto del itinerario de viaje, responde la pregunta del usuario de manera concisa y útil.

Contexto:
${context}

Pregunta: ${pregunta}

Respuesta:`;

                    const response = await this.model.invoke(prompt);
                    return typeof response === 'string' ? response : response.content;
                },
                {
                    name: "buscar_en_itinerario",
                    description: "Busca información en el itinerario de viaje (vuelos, hoteles, tours, actividades, etc.). Usa esta herramienta cuando el usuario pregunte sobre su viaje, horarios, direcciones, reservas, o cualquier información del itinerario.",
                    schema: z.object({
                        pregunta: z.string().describe("La pregunta del usuario sobre el itinerario")
                    })
                }
            );

            const searchPDFTool = tool(
                async ({ solicitud }) => {
                    const result = await this.downloadRequestedPDF(solicitud);
                    if (result.found) {
                        const fileList = result.files.map(f => `- ${f.name} (${f.category})`).join('\n');
                        return `Encontré los siguientes documentos:\n${fileList}\n\nLos documentos han sido descargados y están disponibles.`;
                    } else {
                        return result.message;
                    }
                },
                {
                    name: "buscar_y_descargar_documento",
                    description: "Busca y descarga documentos PDF específicos (boletos, reservas, confirmaciones, etc.). Usa esta herramienta cuando el usuario solicite explícitamente un documento o PDF.",
                    schema: z.object({
                        solicitud: z.string().describe("Descripción del documento que el usuario está solicitando (ej: 'boletos museo vaticano', 'reserva hotel roma')")
                    })
                }
            );

            // Obtener tools del MCP de Supabase
            let mcpTools = [];
            try {
                const mcpConfig = JSON.parse(await fs.readFile('mcp.json', 'utf-8'));
                const supabaseConfig = mcpConfig.mcpServers.supabase;

                if (supabaseConfig) {
                    this.mcpClient = new MultiServerMCPClient({
                        supabase: {
                            transport: "http",
                            url: supabaseConfig.url,
                            headers: supabaseConfig.headers
                        }
                    });

                    mcpTools = await this.mcpClient.getTools();
                    console.log(`MCP Tools de Supabase: ${mcpTools.length} disponibles`);
                }
            } catch (mcpError) {
                console.warn('No se pudieron cargar MCP tools:', mcpError.message);
            }

            // Combinar todas las tools
            const allTools = [
                getCurrentDateTool,
                searchRAGTool,
                searchPDFTool,
                ...mcpTools
            ];

            console.log(`Total de tools: ${allTools.length} (${allTools.length - mcpTools.length} personalizadas + ${mcpTools.length} MCP)`);

            // Crear el agente con todas las tools
            this.agent = createAgent({
                model: "gpt-4o-mini",
                tools: allTools,
            });

            console.log('Agente unificado creado correctamente');
        } catch (error) {
            console.error('Error inicializando agente:', error);
            throw error;
        }
    }

    async saveConversationHistory(userId, message, role) {
        try {
            await this.supabase
                .from('conversation_history')
                .insert({
                    user_id: userId,
                    message: message,
                    role: role
                });
        } catch (error) {
            console.error("Error guardando historial:", error);
        }
    }

    async getConversationHistory(userId, limit = 10) {
        try {
            const { data, error } = await this.supabase
                .from('conversation_history')
                .select('message, role, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;

            return data.reverse().map(row =>
                `${row.role === 'user' ? 'Usuario' : 'Asistente'}: ${row.message}`
            ).join('\n');
        } catch (error) {
            console.error("Error recuperando historial:", error);
            return "";
        }
    }

    async downloadRequestedPDF(pdfRequest) {
        try {
            let pdfs = [];

            if (this.agent) {
                console.log('Usando agente MCP para buscar documentos...');
                try {
                    const searchPrompt = `Busca en la tabla pdf_files los documentos relacionados con: "${pdfRequest}".

La tabla tiene las columnas: file_name, category, description.
Usa SQL ILIKE para búsqueda flexible.
Busca específicamente documentos que coincidan con las palabras clave importantes de la solicitud.
Por ejemplo, si pide "boletos museo vaticano", busca documentos que contengan "vaticano" y "museo" en file_name o description, no solo todos los documentos con categoría "boleto".

Devuelve el nombre del archivo (file_name), categoría y descripción de los documentos más relevantes.`;

                    const agentResponse = await this.agent.invoke({
                        messages: [{ role: "user", content: searchPrompt }],
                    });

                    console.log('Respuesta del agente MCP:', JSON.stringify(agentResponse, null, 2));

                    const lastMessage = agentResponse.messages[agentResponse.messages.length - 1];
                    const content = lastMessage.content;

                    if (content && content.length > 0) {
                        const fileNames = content.match(/[\w\s]+\.pdf/gi) || [];

                        for (const fileName of fileNames) {
                            const pdfInfo = await this.pdfStorage.getPDFWithURL(fileName.trim());
                            if (pdfInfo) {
                                pdfs.push(pdfInfo);
                            }
                        }
                    }
                } catch (mcpError) {
                    console.warn('Error usando agente MCP:', mcpError.message);
                    console.log('Fallback a búsqueda tradicional...');
                }
            }

            if (pdfs.length === 0) {
                console.log('Usando búsqueda tradicional...');
                pdfs = await this.pdfStorage.searchPDFIntelligent(pdfRequest);
            }

            if (pdfs.length === 0) {
                return {
                    found: false,
                    message: `No se encontró ningún documento relacionado con "${pdfRequest}"`
                };
            }

            await fs.mkdir(this.downloadsDir, { recursive: true });

            const downloadedFiles = [];
            for (const pdf of pdfs) {
                const buffer = await this.pdfStorage.downloadPDFBuffer(pdf.file_name);
                const localPath = path.join(this.downloadsDir, pdf.file_name);
                await fs.writeFile(localPath, buffer);

                downloadedFiles.push({
                    name: pdf.file_name,
                    path: localPath,
                    category: pdf.category,
                    description: pdf.description,
                    downloadUrl: pdf.downloadUrl
                });
            }

            return {
                found: true,
                files: downloadedFiles,
                message: `Se encontró(n) ${downloadedFiles.length} documento(s)`
            };
        } catch (error) {
            console.error('Error descargando PDF:', error);
            return {
                found: false,
                error: true,
                message: `Error al buscar o descargar el documento: ${error.message}`
            };
        }
    }

    async processQuery(question, userId = null) {
        try {
            const messageId = uuidv4();
            console.log("Procesando pregunta:", question);

            if (!this.agent) {
                throw new Error("El agente no ha sido inicializado. Llama a initMCPAgent() primero.");
            }

            // Usar el agente unificado para responder
            const response = await this.agent.invoke({
                messages: [{ role: "user", content: question }],
            });

            // Extraer la respuesta final
            const lastMessage = response.messages[response.messages.length - 1];
            const answer = typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content);

            // Guardar en historial si hay userId
            if (userId) {
                await this.saveConversationHistory(userId, question, 'user');
                await this.saveConversationHistory(userId, answer, 'assistant');
            }

            // Actualizar historial en memoria
            this.conversationHistory += `Usuario: ${question}\nAsistente: ${answer}\n`;

            // Verificar si se descargaron PDFs (revisando el contenido de la respuesta)
            const pdfMentioned = answer.toLowerCase().includes('documento') ||
                                answer.toLowerCase().includes('descargado');

            return {
                messageId,
                sessionId: this.sessionId,
                answer,
                pdfResult: pdfMentioned ? { found: true, message: "Documentos procesados" } : null,
            };
        } catch (error) {
            console.error("Error procesando la consulta:", error);
            throw error;
        }
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function startChat() {
    try {
        console.log("Iniciando sistema de chat...");
        console.log("1. Creando AgenticRAGSystem...");
        const agenticRAG = new AgenticRAGSystem();
        console.log("2. Inicializando vector store...");
        await agenticRAG.initVectorStore();
        console.log("3. Inicializando MCP agent...");
        await agenticRAG.initMCPAgent();
        console.log(`4. Sistema listo! [Session ID: ${agenticRAG.sessionId}]`);
        console.log("Escribe tu pregunta o 'salir' para terminar\n");

        const askQuestion = () => {
            rl.question('Pregunta: ', async (question) => {
                if (question.toLowerCase() === 'salir') {
                    rl.close();
                    return;
                }
                try {
                    const response = await agenticRAG.processQuery(question);
                    console.log('\nRespuesta:', response.answer);

                    if (response.pdfResult) {
                        console.log('\n--- DOCUMENTOS ---');
                        if (response.pdfResult.found) {
                            console.log(response.pdfResult.message);
                            response.pdfResult.files.forEach((file, index) => {
                                console.log(`\n${index + 1}. ${file.name}`);
                                console.log(`   Categoría: ${file.category || 'N/A'}`);
                                console.log(`   Descripción: ${file.description || 'N/A'}`);
                                console.log(`   Descargado en: ${file.path}`);
                                console.log(`   URL: ${file.downloadUrl}`);
                            });
                        } else {
                            console.log(response.pdfResult.message);
                        }
                        console.log('------------------');
                    }

                    console.log(`\nMessage ID: ${response.messageId}`);
                    console.log('\n-------------------\n');
                    askQuestion();
                } catch (error) {
                    console.error('Error:', error);
                    askQuestion();
                }
            });
        };

        askQuestion();
    } catch (error) {
        console.error("Error iniciando el chat:", error);
        rl.close();
    }
}

export { AgenticRAGSystem };

// Si se ejecuta directamente, iniciar el chat
if (import.meta.main) {
    startChat();
}
