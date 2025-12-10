FROM oven/bun:latest

# Directorio de trabajo
WORKDIR /app

# Copiar package files
COPY package.json bun.lockb* ./

# Instalar dependencias
RUN bun install --production

# Copiar código fuente
COPY . .

# Exponer puerto
EXPOSE 5000

# Variables de entorno por defecto
ENV NODE_ENV=production

# Comando de inicio
CMD ["bun", "run", "chatwhats.js"]
