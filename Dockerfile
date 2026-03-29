FROM node:20-alpine

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm install

# Install and build frontend
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

COPY . .

RUN cd frontend && npm run build

EXPOSE 3000

CMD ["npx", "tsx", "src/app.ts"]
