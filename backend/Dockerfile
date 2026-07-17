# Build stage
FROM node:20.19-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20.19-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ghostscript \
    python3 \
    python3-pip \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-ind \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --only=production
COPY requirements-docx.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements-docx.txt
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/scripts ./dist/scripts

EXPOSE 3000

CMD ["node", "dist/app.js"]
