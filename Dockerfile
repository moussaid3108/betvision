FROM node:20-alpine

WORKDIR /app

# Installer les dépendances en premier (cache Docker)
COPY package.json ./
RUN npm install --production

# Copier le reste du code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
