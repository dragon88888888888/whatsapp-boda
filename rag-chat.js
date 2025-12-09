import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
}

import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { HumanMessage } from "@langchain/core/messages";
import { StateGraph } from "@langchain/langgraph";
import { MemorySaver, Annotation } from "@langchain/langgraph";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import dotenv from "dotenv";

dotenv.config();

//Función para buscar videos en YouTube utilizando la API de YouTube Data v3
async function youtubeSearch(query) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    const channelId = process.env.YOUTUBE_CHANNEL_ID; 
    if (!apiKey) {
        throw new Error("Falta YOUTUBE_API_KEY en las variables de entorno");
    }
    if (!channelId) {
        throw new Error("Falta YOUTUBE_CHANNEL_ID en las variables de entorno");
    }
    const maxResults = 3;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&channelId=${process.env.YOUTUBE_CHANNEL_ID}&q=${encodeURIComponent(query)}&maxResults=${maxResults}&key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Error en la API de YouTube: ${response.statusText}`);
    }
    const data = await response.json();
    if (data.items && data.items.length > 0) {
        // Procesamos cada resultado y los unimos en un solo string, separados por saltos de línea
        return data.items.map(item => {
            const videoId = item.id.videoId;
            const title = item.snippet.title;
            return `https://www.youtube.com/watch?v=${videoId} (${title})`;
        }).join("\n");
    }
    return "No se encontró video relacionado";

}


class AgenticRAGSystem {
    constructor() {
        this.pinecone = new Pinecone();
        this.pineconeIndex = this.pinecone.Index(process.env.PINECONE_INDEX);
        this.embeddings = new GoogleGenerativeAIEmbeddings({
            model: "text-embedding-004",
            taskType: TaskType.RETRIEVAL_DOCUMENT,
        });
        this.model = new ChatGoogleGenerativeAI({
            model: "gemini-2.0-flash-lite",
            maxOutputTokens: 2048,
            apiKey: process.env.GOOGLE_API_KEY,
        });
        this.sessionId = uuidv4(); // ID único por sesión
        this.conversationHistory = ""; // Historial de la conversación
    }

    async initVectorStore() {
        this.vectorStore = await PineconeStore.fromExistingIndex(this.embeddings, {
            pineconeIndex: this.pineconeIndex,
        });
        return this.vectorStore;
    }

    // Método para extraer palabras clave a partir de un texto usando el LLM
    async extractKeywords(text) {
        const promptText = `Resume la siguiente respuesta a solo dos palabras clave para buscar videos en YouTube. Solo proporciona las dos palabras clave separadas por comas.

Respuesta: ${text}

Palabras clave:`;
        const result = await this.model.invoke(promptText);
    
        const keywords = (typeof result === 'string') ? result : result.content;
        return keywords.trim();
    }


    // Nodo RAG que procesa la pregunta y actualiza el historial
    async ragChainNode(question) {
        const retriever = this.vectorStore.asRetriever({ k: 2000 });
        const prompt = ChatPromptTemplate.fromMessages([
            ["system", `Eres un filósofo que responde preguntas utilizando el contexto recuperado y el historial de conversación. responde en formato Markdown.
Historial: {conversationHistory}
Pregunta: {question}
Contexto: {context}
Respuesta:`],
        ]);
        const chain = await createStuffDocumentsChain({
            llm: this.model,
            prompt,
            outputParser: new StringOutputParser(),
        });
        const retrievedDocs = await retriever.invoke(question);
        const ragResponse = await chain.invoke({
            question,
            context: retrievedDocs,
            conversationHistory: this.conversationHistory,
        });
        // Actualizamos el historial: concatenamos la pregunta y respuesta
        this.conversationHistory += `Pregunta: ${question}\nRespuesta: ${ragResponse}\n`;
        return ragResponse;
    }

    // Nodo "agent": procesa la pregunta usando el RAG y retorna la respuesta
    async agentNode(state) {
        const lastMsg = state.messages[state.messages.length - 1];
        const answer = await this.ragChainNode(lastMsg.content);
        return { messages: [new HumanMessage(answer)] };
    }

    // NUEVO nodo "youtube": utiliza la última respuesta del historial para buscar un video relacionado
    async youtubeSearchNode(state) {
        // Extraemos la última respuesta
        const segments = this.conversationHistory.split('Respuesta:');
        const lastAnswer = segments[segments.length - 1].trim();
        // Usamos el LLM para extraer palabras clave que resuman el tema central
        const keywords = await this.extractKeywords(lastAnswer);
        console.log("Palabras clave extraídas:", keywords);
        const videoResult = await youtubeSearch(keywords);
        return { messages: [new HumanMessage(`Video relacionado: ${videoResult}`)] };
    }

    // Creamos el grafo de agentes que incluye el nodo RAG y el nodo de búsqueda en YouTube
    async createAgentGraph() {
        const GraphState = Annotation.Root({
            messages: Annotation({
                reducer: (x, y) => x.concat(y),
            }),
        });

        // Nodo que procesa la respuesta RAG
        const agentNodeFunc = async (state) => {
            const lastMsg = state.messages[state.messages.length - 1];
            const answer = await this.ragChainNode(lastMsg.content);
            return { messages: [new HumanMessage(answer)] };
        };

        // Nodo que usa la respuesta del RAG para buscar un video en YouTube, usando las palabras clave extraídas
        const youtubeNodeFunc = async (state) => {
            const segments = this.conversationHistory.split('Respuesta:');
            const lastAnswer = segments[segments.length - 1].trim();
            const keywords = await this.extractKeywords(lastAnswer);
            //console.log("Palabras clave extraídas en nodo YouTube:", keywords);
            const videoResult = await youtubeSearch(keywords);
            return { messages: [new HumanMessage(`Videos recomendados: ${videoResult}`)] };
        };

        // Construimos el grafo:
        // - Desde el inicio se llama al nodo "agent"
        // - Luego, se hacen dos transiciones:
        //   1. Desde "agent" directamente a "__end__" para guardar la respuesta del RAG.
        //   2. Desde "agent" a "youtube" para obtener el enlace del video.
        // - Ambos caminos terminan en "__end__".
        const workflow = new StateGraph(GraphState)
            .addNode("agent", agentNodeFunc)
            .addNode("youtube", youtubeNodeFunc)
            .addEdge("__start__", "agent")
            .addEdge("agent", "__end__")      // Rama directa para la respuesta RAG
            .addEdge("agent", "youtube")       // Rama para búsqueda en YouTube
            .addEdge("youtube", "__end__");    // Rama final para YouTube

        const checkpointer = new MemorySaver();
        return workflow.compile();
    }

    async processQuery(question) {
        try {
            const messageId = uuidv4();
            console.log("Procesando pregunta:", question);
            const agentGraph = await this.createAgentGraph();
            const graphState = await agentGraph.invoke({
                messages: [new HumanMessage(question)],
            }, {
                configurable: {
                    thread_id: this.sessionId,
                    checkpoint_id: messageId,
                },
            });
            // Tomamos los dos últimos mensajes, suponiendo:
            // - Penúltimo: respuesta del RAG
            // - Último: resultado de la búsqueda en YouTube
            const lastTwo = graphState.messages.slice(-2);
            const combined = lastTwo.map(msg => msg.content).join("\n\n");
            return {
                messageId,
                sessionId: this.sessionId,
                answer: combined,
            };
        } catch (error) {
            console.error("Error procesando la consulta:", error);
            throw error;
        }
    }
}

// Interfaz de consola
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function startChat() {
    try {
        console.log("Iniciando sistema de chat...");
        const agenticRAG = new AgenticRAGSystem();
        await agenticRAG.initVectorStore();
        console.log(`Sistema listo! [Session ID: ${agenticRAG.sessionId}]`);
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
                    console.log(`Message ID: ${response.messageId}`);
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

