//document-index.js
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import fs from 'fs/promises';
import path from 'path';
import dotenv from "dotenv";

dotenv.config();

async function loadPDFsFromDirectory(directoryPath) {
    const files = await fs.readdir(directoryPath);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));

    console.log(`Encontrados ${pdfFiles.length} archivos PDF en el directorio`);

    let allDocs = [];
    for (const pdfFile of pdfFiles) {
        const fullPath = path.join(directoryPath, pdfFile);
        console.log(`Procesando: ${pdfFile}`);

        try {
            const loader = new PDFLoader(fullPath);
            const docs = await loader.load();
            allDocs = [...allDocs, ...docs];
            console.log(`✓ ${pdfFile}: ${docs.length} páginas cargadas`);
        } catch (error) {
            console.error(`Error al cargar ${pdfFile}:`, error.message);
        }
    }

    return allDocs;
}

// Función para dividir array en lotes
function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

async function indexDocuments() {
    try {
        console.log("Iniciando indexación de documentos...");

        // Inicializar Pinecone y embeddings
        const pinecone = new Pinecone();
        const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
        const embeddings = new GoogleGenerativeAIEmbeddings({
            model: "text-embedding-004",
            taskType: TaskType.RETRIEVAL_DOCUMENT,
        });

        console.log("Conectado a Pinecone, inicializando vector store...");

        // Inicializar vector store
        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
            maxConcurrency: 5,
        });

        // Configurar text splitter
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        console.log("Cargando documentos...");

        // Cargar PDFs desde el directorio
        const pdfDocs = await loadPDFsFromDirectory('./arcanos');
        console.log(`Total de documentos PDF cargados: ${pdfDocs.length}`);

        console.log("Procesando y dividiendo documentos...");
        // Procesar documentos
        const splits = await textSplitter.splitDocuments(pdfDocs);
        console.log(`Total de chunks a procesar: ${splits.length}`);

        // Procesar en lotes de 50 documentos
        const batches = chunkArray(splits, 50);
        console.log(`Dividido en ${batches.length} lotes`);

        let processedCount = 0;
        for (let i = 0; i < batches.length; i++) {
            try {
                const batch = batches[i];
                const batchIds = Array.from(
                    { length: batch.length },
                    (_, index) => (processedCount + index + 1).toString()
                );

                console.log(`Procesando lote ${i + 1}/${batches.length}`);
                await vectorStore.addDocuments(batch, { ids: batchIds });

                processedCount += batch.length;
                console.log(`✓ Lote ${i + 1} completado. Procesados: ${processedCount}/${splits.length}`);

                // Pequeña pausa entre lotes
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Error en lote ${i + 1}:`, error.message);
                console.log('Intentando continuar con el siguiente lote...');
            }
        }

        console.log("\n¡Indexación completada!");
        console.log("Total de chunks procesados:", processedCount);

    } catch (error) {
        console.error("Error durante la indexación:", error);
    }
}

// Ejecutar la indexación
indexDocuments();