# Imagen base con Node.js + Playwright
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm ci

# Copiar el resto del código fuente
COPY tsconfig.json ./
COPY src ./src

# Compilar TypeScript a JavaScript
RUN npm run build

# Variables de entorno
ENV NODE_ENV=production
ENV PORT=3333

# Puerto informativo
EXPOSE 3333

# Comando de inicio
CMD ["npm", "start"]
