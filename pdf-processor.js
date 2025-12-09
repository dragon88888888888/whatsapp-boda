import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from "dotenv";

dotenv.config();

/**
 * Clase para manejar el procesamiento de PDFs y su carga en Pinecone
 */
export class PDFProcessor {
    constructor() {
        // Inicializar Pinecone
        this.pinecone = new Pinecone();
        this.pineconeIndex = this.pinecone.Index(process.env.PINECONE_INDEX);

        // Inicializar embeddings
        this.embeddings = new GoogleGenerativeAIEmbeddings({
            model: "text-embedding-004",
            taskType: TaskType.RETRIEVAL_DOCUMENT,
        });

        // Configurar text splitter
        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        // Directorio temporal para guardar PDFs
        this.tempDir = path.join(os.tmpdir(), 'pdf_uploads');
    }

    /**
     * Inicializar el vector store
     */
    async initVectorStore() {
        // Crear directorio temporal si no existe
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
            console.log(`Directorio temporal creado: ${this.tempDir}`);
        } catch (error) {
            console.error('Error al crear directorio temporal:', error);
        }

        // Inicializar vector store
        this.vectorStore = await PineconeStore.fromExistingIndex(this.embeddings, {
            pineconeIndex: this.pineconeIndex,
            maxConcurrency: 5,
        });

        console.log("Vector store inicializado correctamente");
        return this.vectorStore;
    }

    /**
     * Procesar un archivo PDF y cargarlo en Pinecone
     * @param {Buffer} fileBuffer - Buffer del archivo PDF
     * @param {string} fileName - Nombre del archivo
     * @returns {Promise<Object>} - Resultado del procesamiento
     */
    async processPDF(fileBuffer, fileName) {
        try {
            console.log(`Procesando PDF: ${fileName}`);

            // Guardar el archivo temporalmente
            const tempFilePath = path.join(this.tempDir, fileName);
            await fs.writeFile(tempFilePath, fileBuffer);
            console.log(`Archivo guardado temporalmente en: ${tempFilePath}`);

            // Cargar PDF
            const loader = new PDFLoader(tempFilePath);
            const docs = await loader.load();
            console.log(`PDF cargado: ${docs.length} páginas`);

            // Dividir en chunks
            const splits = await this.textSplitter.splitDocuments(docs);
            console.log(`Documento dividido en ${splits.length} chunks`);

            // Definir IDs únicos para cada chunk
            const currentTimestamp = Date.now();
            const docIds = splits.map((_, index) =>
                `${fileName.replace(/[^a-zA-Z0-9]/g, '_')}_${currentTimestamp}_${index}`
            );

            // Agregar al vector store
            await this.vectorStore.addDocuments(splits, { ids: docIds });
            console.log(`✅ Documento añadido al vector store: ${fileName}`);

            // Eliminar archivo temporal
            await fs.unlink(tempFilePath);
            console.log(`Archivo temporal eliminado: ${tempFilePath}`);

            return {
                success: true,
                fileName,
                chunks: splits.length,
                message: `Se ha procesado y añadido el documento "${fileName}" (${splits.length} segmentos) a la base de conocimiento.`
            };
        } catch (error) {
            console.error(`Error procesando PDF ${fileName}:`, error);
            return {
                success: false,
                fileName,
                error: error.message,
                message: `Error al procesar el documento "${fileName}": ${error.message}`
            };
        }
    }

    /**
     * Dividir array en lotes
     * @param {Array} array - Array a dividir
     * @param {number} chunkSize - Tamaño de cada lote
     * @returns {Array} - Array de lotes
     */
    chunkArray(array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }
}

// Exportar instancia singleton
export default new PDFProcessor();