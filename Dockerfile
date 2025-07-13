# Use official Node.js 20 LTS Alpine image for build stage (pinned version for stability)
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install ALL dependencies first (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Production stage with distroless image (Node.js 20)
FROM gcr.io/distroless/nodejs20-debian12

# Set working directory
WORKDIR /app

# Copy built application and node_modules from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Use non-root user for security (node user in distroless is uid 65532)
USER 65532

# Expose port
EXPOSE 8080

# Start the application
CMD ["dist/index.js"]
