import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { createClient } from "@supabase/supabase-js";
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

            // Agregar metadata del archivo a cada documento
            docs.forEach(doc => {
                doc.metadata = {
                    ...doc.metadata,
                    fileName: pdfFile,
                    filePath: fullPath,
                    category: categorizeDocument(pdfFile),
                };
            });

            allDocs = [...allDocs, ...docs];
            console.log(`✓ ${pdfFile}: ${docs.length} páginas cargadas`);
        } catch (error) {
            console.error(`Error al cargar ${pdfFile}:`, error.message);
        }
    }

    return allDocs;
}

// Funcion para categorizar documentos segun su nombre
function categorizeDocument(fileName) {
    const lower = fileName.toLowerCase();

    if (lower.includes('bar') || lower.includes('bares')) {
        return 'bares';
    }

    if (lower.includes('taco') || lower.includes('tacos')) {
        return 'tacos';
    }

    if (lower.includes('torta') || lower.includes('tortas')) {
        return 'tortas';
    }

    if (lower.includes('fit') || lower.includes('saludable') || lower.includes('healthy')) {
        return 'comida-fit';
    }

    if (lower.includes('template') || lower.includes('mundial')) {
        return 'general';
    }

    return 'otros';
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

        // Inicializar Supabase
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // Inicializar embeddings de OpenAI
        const embeddings = new OpenAIEmbeddings({
            modelName: "text-embedding-3-small",
            openAIApiKey: process.env.OPENAI_API_KEY,
        });

        console.log("Conectado a Supabase, inicializando vector store...");

        // Configurar text splitter
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        console.log("Cargando documentos...");

        // Cargar PDFs desde el directorio del itinerario
        const pdfDocs = await loadPDFsFromDirectory('./mundial-20260123T012440Z-3-001/mundial');
        console.log(`Total de documentos PDF cargados: ${pdfDocs.length}`);

        console.log("Procesando y dividiendo documentos...");
        const splits = await textSplitter.splitDocuments(pdfDocs);
        console.log(`Total de chunks a procesar: ${splits.length}`);

        // Limpiar tabla de documentos (opcional - comentar si quieres mantener datos existentes)
        console.log("Limpiando datos existentes...");
        await supabase.from('documents').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        // Procesar en lotes de 50 documentos
        const batches = chunkArray(splits, 50);
        console.log(`Dividido en ${batches.length} lotes`);

        let processedCount = 0;
        for (let i = 0; i < batches.length; i++) {
            try {
                const batch = batches[i];
                console.log(`Procesando lote ${i + 1}/${batches.length}`);

                // Crear vector store y agregar documentos
                await SupabaseVectorStore.fromDocuments(
                    batch,
                    embeddings,
                    {
                        client: supabase,
                        tableName: "documents",
                        queryName: "match_documents"
                    }
                );

                processedCount += batch.length;
                console.log(`✓ Lote ${i + 1} completado. Procesados: ${processedCount}/${splits.length}`);

                // Pequeña pausa entre lotes para no sobrecargar la API
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Error en lote ${i + 1}:`, error.message);
                console.log('Intentando continuar con el siguiente lote...');
            }
        }

        // Guardar metadata de los PDFs en la tabla pdf_files
        console.log("\nGuardando metadata de PDFs...");
        const files = await fs.readdir('./mundial-20260123T012440Z-3-001/mundial');
        const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));

        for (const pdfFile of pdfFiles) {
            const fullPath = path.join('./mundial-20260123T012440Z-3-001/mundial', pdfFile);
            const category = categorizeDocument(pdfFile);

            try {
                await supabase.from('pdf_files').insert({
                    file_name: pdfFile,
                    file_path: fullPath,
                    file_type: 'application/pdf',
                    category: category,
                    description: generateDescription(pdfFile, category),
                    storage_path: `wedding-documents/${pdfFile}`,
                });
                console.log(`✓ Metadata guardada para: ${pdfFile}`);
            } catch (error) {
                console.error(`Error guardando metadata de ${pdfFile}:`, error.message);
            }
        }

        console.log("\n¡Indexación completada!");
        console.log("Total de chunks procesados:", processedCount);
        console.log("Total de PDFs registrados:", pdfFiles.length);

    } catch (error) {
        console.error("Error durante la indexación:", error);
    }
}

// Función para generar descripción basada en el nombre del archivo
function generateDescription(fileName, category) {
    const match = fileName.match(/^(\d+)\s+(.+)\.pdf$/i);
    if (match) {
        const description = match[2];
        return description.replace(/[_-]/g, ' ');
    }
    return fileName.replace('.pdf', '').replace(/[_-]/g, ' ');
}

// Ejecutar la indexación
indexDocuments();
