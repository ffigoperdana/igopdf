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

# The runtime image is shared by the API and the conversion workers. Run all
# application processes with a fixed non-root UID; compose initializes the
# writable volumes to this UID before either service starts.
RUN groupadd --gid 10001 igo \
  && useradd --uid 10001 --gid igo --create-home --home-dir /home/igo \
    --shell /usr/sbin/nologin igo \
  && install -d --owner=igo --group=igo --mode=0700 \
    /var/lib/igo-jobs /var/lib/igo-support

COPY --chown=igo:igo package*.json ./
RUN npm ci --only=production
COPY --chown=igo:igo requirements-docx.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements-docx.txt
COPY --chown=igo:igo --from=builder /app/dist ./dist
COPY --chown=igo:igo --from=builder /app/src/scripts ./dist/scripts

EXPOSE 3000

USER igo

CMD ["node", "dist/app.js"]
