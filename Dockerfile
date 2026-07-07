# Single image for both web and worker (compose sets the command per service).
FROM node:22-alpine

# argon2 is a native module — needs a toolchain to compile at install time.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Default command; compose overrides for the worker.
CMD ["npx", "tsx", "src/index.ts"]
