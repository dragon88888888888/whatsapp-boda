import { createClient } from "@supabase/supabase-js";
import fs from 'fs/promises';
import path from 'path';
import dotenv from "dotenv";

dotenv.config();

class PDFStorage {
    constructor() {
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );
        this.bucketName = 'mundial';
    }

    async uploadPDF(filePath, fileName = null) {
        try {
            if (!fileName) {
                fileName = path.basename(filePath);
            }

            const fileBuffer = await fs.readFile(filePath);

            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .upload(fileName, fileBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                });

            if (error) {
                throw error;
            }

            console.log(`✓ PDF subido: ${fileName}`);
            return data;
        } catch (error) {
            console.error(`Error subiendo ${fileName}:`, error.message);
            throw error;
        }
    }

    async uploadAllPDFsFromDirectory(directoryPath) {
        try {
            const files = await fs.readdir(directoryPath);
            const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));

            console.log(`Encontrados ${pdfFiles.length} archivos PDF para subir`);

            let successCount = 0;
            let errorCount = 0;

            for (const pdfFile of pdfFiles) {
                const fullPath = path.join(directoryPath, pdfFile);
                try {
                    await this.uploadPDF(fullPath, pdfFile);
                    successCount++;
                } catch (error) {
                    errorCount++;
                    console.error(`Error al subir ${pdfFile}:`, error.message);
                }
            }

            console.log(`\nResumen de subida:`);
            console.log(`Exitosos: ${successCount}`);
            console.log(`Errores: ${errorCount}`);
            console.log(`Total: ${pdfFiles.length}`);

            return { successCount, errorCount, total: pdfFiles.length };
        } catch (error) {
            console.error('Error leyendo directorio:', error.message);
            throw error;
        }
    }

    async getSignedURL(fileName, expiresIn = 3600) {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .createSignedUrl(fileName, expiresIn);

            if (error) {
                throw error;
            }

            return data.signedUrl;
        } catch (error) {
            console.error(`Error generando URL firmada para ${fileName}:`, error.message);
            throw error;
        }
    }

    async findPDFByKeyword(keyword) {
        try {
            const { data, error } = await this.supabase
                .from('pdf_files')
                .select('*')
                .or(`file_name.ilike.%${keyword}%,description.ilike.%${keyword}%,category.ilike.%${keyword}%`);

            if (error) {
                throw error;
            }

            return data;
        } catch (error) {
            console.error(`Error buscando PDF con keyword "${keyword}":`, error.message);
            throw error;
        }
    }

    async findPDFByCategory(category) {
        try {
            const { data, error } = await this.supabase
                .from('pdf_files')
                .select('*')
                .eq('category', category);

            if (error) {
                throw error;
            }

            return data;
        } catch (error) {
            console.error(`Error buscando PDFs de categoría "${category}":`, error.message);
            throw error;
        }
    }

    async getPDFWithURL(fileName) {
        try {
            const { data: fileData, error: dbError } = await this.supabase
                .from('pdf_files')
                .select('*')
                .eq('file_name', fileName)
                .single();

            if (dbError) {
                throw dbError;
            }

            const signedUrl = await this.getSignedURL(fileName);

            return {
                ...fileData,
                downloadUrl: signedUrl
            };
        } catch (error) {
            console.error(`Error obteniendo PDF ${fileName} con URL:`, error.message);
            throw error;
        }
    }

    async downloadPDFBuffer(fileName) {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .download(fileName);

            if (error) {
                throw error;
            }

            const arrayBuffer = await data.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            console.error(`Error descargando buffer de ${fileName}:`, error.message);
            throw error;
        }
    }

    async searchPDFIntelligent(query) {
        try {
            const lowerQuery = query.toLowerCase();

            // Buscar primero por keyword general
            let results = await this.findPDFByKeyword(query);

            // Si no hay resultados, intentar por categorías específicas
            if (results.length === 0) {
                const categories = ['boleto', 'hotel', 'traslado', 'tour', 'tren', 'itinerario'];

                for (const cat of categories) {
                    if (lowerQuery.includes(cat)) {
                        results = await this.findPDFByCategory(cat);
                        break;
                    }
                }
            }

            // Agregar URLs firmadas a los resultados
            const resultsWithURLs = await Promise.all(
                results.map(async (pdf) => {
                    const signedUrl = await this.getSignedURL(pdf.file_name);
                    return {
                        ...pdf,
                        downloadUrl: signedUrl
                    };
                })
            );

            return resultsWithURLs;
        } catch (error) {
            console.error(`Error en búsqueda inteligente de PDF:`, error.message);
            throw error;
        }
    }
}

// Función para ejecutar la subida inicial de PDFs
async function uploadInitialPDFs() {
    console.log("Iniciando subida de PDFs a Supabase Storage...");
    const storage = new PDFStorage();

    try {
        await storage.uploadAllPDFsFromDirectory('./mundial-20260123T012440Z-3-001/mundial');
        console.log("\n¡Subida completada!");
    } catch (error) {
        console.error("Error durante la subida:", error);
    }
}

export { PDFStorage, uploadInitialPDFs };

// Si se ejecuta directamente el script
if (import.meta.main) {
    uploadInitialPDFs();
}
