FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production --omit=dev

COPY . .

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production

CMD ["npm", "start"]
