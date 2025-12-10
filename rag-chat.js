import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
}

import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { HumanMessage } from "@langchain/core/messages";
import { StateGraph, START, END, MessagesAnnotation, Annotation } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import dotenv from "dotenv";
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const StateAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec,
    downloadedFiles: Annotation({
        reducer: (left, right) => right ?? left ?? [],
        default: () => []
    })
});

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

        this.sessionId = uuidv4();
        this.downloadsDir = './downloads';
        this.mcpTools = null;
        this.model = null;
        this.agentGraph = null;
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

    async initMCPTools() {
        try {
            const mcpConfig = JSON.parse(await fs.readFile('mcp.json', 'utf-8'));
            const supabaseConfig = mcpConfig.mcpServers.supabase;

            if (!supabaseConfig) {
                console.warn('No se encontró configuración de Supabase MCP, continuando sin MCP tools');
                this.mcpTools = [];
                this.model = new ChatOpenAI({
                    modelName: "gpt-4o-mini",
                    temperature: 0.7,
                    maxTokens: 2048,
                    openAIApiKey: process.env.OPENAI_API_KEY,
                });
                await this.initAgentGraph();
                return;
            }

            const mcpClient = new MultiServerMCPClient({
                supabase: {
                    transport: supabaseConfig.transport,
                    url: supabaseConfig.url,
                    headers: supabaseConfig.headers
                }
            });

            this.mcpTools = await mcpClient.getTools();
            console.log(`MCP Tools inicializadas: ${this.mcpTools.length} tools disponibles`);

            this.model = new ChatOpenAI({
                modelName: "gpt-4o-mini",
                temperature: 0.7,
                maxTokens: 2048,
                openAIApiKey: process.env.OPENAI_API_KEY,
            }).bindTools(this.mcpTools);

            await this.initAgentGraph();

        } catch (error) {
            console.warn('Error inicializando MCP tools:', error.message);
            this.mcpTools = [];
            this.model = new ChatOpenAI({
                modelName: "gpt-4o-mini",
                temperature: 0.7,
                maxTokens: 2048,
                openAIApiKey: process.env.OPENAI_API_KEY,
            });
            await this.initAgentGraph();
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

    getCurrentDate() {
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
    }

    getShortDate() {
        const now = new Date();
        const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
        const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
        const month = months[parisTime.getMonth()];
        const day = parisTime.getDate();
        return `${month} ${day}`;
    }

    async initAgentGraph() {
        const agentNodeFunc = async (state) => {
            const messages = state.messages;
            const lastMsg = messages[messages.length - 1];

            const retriever = this.vectorStore.asRetriever({ k: 15 });
            const retrievedDocs = await retriever.invoke(lastMsg.content);
            const formattedDocs = retrievedDocs
                .map(doc => doc.pageContent)
                .join('\n\n');

            const currentDate = this.getCurrentDate();
            const shortDate = this.getShortDate();

            const systemPrompt = `Eres un asistente de viaje especializado en ayudar con el itinerario de una luna de miel en Europa.

FECHA ACTUAL: ${currentDate}
FECHA EN FORMATO ITINERARIO: ${shortDate}

IMPORTANTE: Cuando el usuario pregunte sobre "hoy", "que tengo que hacer hoy", o actividades del día:
1. Busca en el contexto la fecha "${shortDate}" en el itinerario
2. Lee CUIDADOSAMENTE todos los eventos y horarios del día
3. Incluye TODOS los horarios y actividades programadas (mañana, tarde, noche)
4. No omitas ningún evento aunque parezca menor
5. Revisa TODO el contexto recuperado para no perderte ninguna actividad

Tu trabajo es proporcionar información útil sobre:
- Horarios de vuelos, trenes y traslados
- Direcciones y detalles de hoteles
- Información sobre tours y actividades
- Recomendaciones generales de viaje

Tienes acceso a herramientas de Supabase para consultar la base de datos.

Cuando el usuario solicite documentos, boletos, reservas o archivos PDF:
1. USA la función SQL: SELECT * FROM get_pdf_download_url('palabra_clave')
2. Reemplaza 'palabra_clave' con lo que el usuario busca (museo, boleto, hotel, etc.)
3. La función devuelve: file_name, category, description, download_url
4. SIEMPRE incluye las URLs de descarga en tu respuesta en formato Markdown:
   - Ejemplo: [Nombre del documento](URL_completa)

Categorías disponibles: boleto, hotel, traslado, tour, tren, itinerario

Contexto recuperado de los documentos vectorizados:
${formattedDocs}

Responde de manera clara y concisa en formato Markdown.`;

            const messagesWithSystem = [
                { role: "system", content: systemPrompt },
                ...messages
            ];

            const result = await this.model.invoke(messagesWithSystem);
            return { messages: [result] };
        };

        const shouldContinue = (state) => {
            const messages = state.messages;
            const lastMessage = messages[messages.length - 1];

            if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
                return "tools";
            }
            return "postProcess";
        };

        const postProcessNode = async (state) => {
            const messages = state.messages;
            const lastMessage = messages[messages.length - 1];
            const content = lastMessage.content || "";

            console.log("Post-procesando respuesta...");
            const urlRegex = /https:\/\/[^\s\)]+\.pdf/gi;
            const urls = content.match(urlRegex);

            if (!urls || urls.length === 0) {
                console.log("No hay URLs de PDF para procesar");
                return { messages: messages, downloadedFiles: [] };
            }

            console.log(`Descargando ${urls.length} archivo(s)...`);
            await fs.mkdir(this.downloadsDir, { recursive: true });
            const downloadedFiles = [];

            for (const url of urls) {
                try {
                    const fileName = decodeURIComponent(url.split('/').pop());
                    const localPath = path.join(this.downloadsDir, fileName);

                    const response = await fetch(url);
                    if (!response.ok) {
                        console.error(`Error descargando ${fileName}: ${response.status}`);
                        continue;
                    }

                    const buffer = await response.arrayBuffer();
                    await fs.writeFile(localPath, Buffer.from(buffer));

                    downloadedFiles.push({
                        name: fileName,
                        path: localPath,
                        url: url
                    });

                    console.log(`✓ Descargado: ${fileName}`);
                } catch (error) {
                    console.error(`Error descargando archivo de ${url}:`, error.message);
                }
            }

            let modifiedContent = content;

            const markdownLinkRegex = /\[([^\]]+)\]\(https:\/\/[^\)]+\.pdf\)/gi;
            modifiedContent = modifiedContent.replace(markdownLinkRegex, (match, linkText) => {
                return `📎 ${linkText}`;
            });

            modifiedContent = modifiedContent.replace(urlRegex, '');

            modifiedContent = modifiedContent.replace(/\n{3,}/g, '\n\n');
            modifiedContent = modifiedContent.trim();

            const modifiedMessages = [...messages];
            modifiedMessages[modifiedMessages.length - 1] = {
                ...lastMessage,
                content: modifiedContent
            };

            return {
                messages: modifiedMessages,
                downloadedFiles: downloadedFiles
            };
        };

        const workflow = new StateGraph(StateAnnotation)
            .addNode("agent", agentNodeFunc)
            .addNode("postProcess", postProcessNode)
            .addEdge(START, "agent");

        if (this.mcpTools && this.mcpTools.length > 0) {
            const toolNode = new ToolNode(this.mcpTools);
            workflow
                .addNode("tools", toolNode)
                .addConditionalEdges("agent", shouldContinue, {
                    tools: "tools",
                    postProcess: "postProcess"
                })
                .addEdge("tools", "agent");
        } else {
            workflow.addConditionalEdges("agent", shouldContinue, {
                postProcess: "postProcess"
            });
        }

        workflow.addEdge("postProcess", END);

        const checkpointer = new MemorySaver();
        this.agentGraph = workflow.compile({ checkpointer });
        console.log("Grafo del agente compilado exitosamente");
    }

    async processQuery(question, userId = null) {
        try {
            const messageId = uuidv4();
            console.log("Procesando pregunta:", question);

            if (!this.agentGraph) {
                throw new Error("El grafo del agente no está inicializado");
            }

            const graphState = await this.agentGraph.invoke({
                messages: [new HumanMessage(question)],
            }, {
                configurable: {
                    thread_id: this.sessionId,
                },
            });

            const messages = graphState.messages;
            const lastMessage = messages[messages.length - 1];
            const answer = lastMessage.content || "";
            const downloadedFiles = graphState.downloadedFiles || [];

            if (userId) {
                await this.saveConversationHistory(userId, question, 'user');
                await this.saveConversationHistory(userId, answer, 'assistant');
            }

            return {
                messageId,
                sessionId: this.sessionId,
                answer: answer,
                downloadedFiles: downloadedFiles,
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
        console.log("3. Inicializando MCP tools...");
        await agenticRAG.initMCPTools();
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

                    if (response.downloadedFiles && response.downloadedFiles.length > 0) {
                        console.log('\n--- ARCHIVOS DESCARGADOS ---');
                        response.downloadedFiles.forEach((file, index) => {
                            console.log(`\n${index + 1}. ${file.name}`);
                            console.log(`   Ruta local: ${file.path}`);
                            console.log(`   URL: ${file.url}`);
                        });
                        console.log('---------------------------');
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
