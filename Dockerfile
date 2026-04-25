# Railway deploy v3
FROM node:20-alpine

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm install

# Install frontend dependencies
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Install landing page dependencies
COPY landing/package*.json landing/package-lock.json* ./landing/
RUN cd landing && npm install

COPY . .

# Build both SPAs
RUN cd frontend && npm run build
RUN cd landing && npm run build

EXPOSE 3000

CMD ["npx", "tsx", "src/app.ts"]
