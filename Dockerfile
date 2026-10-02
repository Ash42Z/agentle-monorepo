FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client python3 ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 coder && useradd -u 10001 -g 10001 -m coder
RUN npm install -g @openai/codex@0.160.0
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
CMD ["npm","start"]
