FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV NODE_ENV=production
ENV PORT=10000
ENV MAX_CONCURRENT=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 10000

CMD ["npm", "start"]
