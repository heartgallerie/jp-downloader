FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production
ENV PORT=10000
ENV MAX_CONCURRENT=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server_fast.js ./
COPY client-fast.js ./
COPY server.js ./
COPY public ./public

EXPOSE 10000

CMD ["npm", "start"]
