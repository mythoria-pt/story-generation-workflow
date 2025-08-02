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

# Production stage with Debian-based image for Ghostscript support
FROM node:20-slim

# Install system dependencies for PDF processing
RUN apt-get update && apt-get install -y \
    ghostscript \
    wget \
    gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create directories for ICC profiles and temp files
RUN mkdir -p /app/icc-profiles /tmp/mythoria-print

# Copy built application and node_modules from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy ICC profile configuration
COPY src/config/icc-profiles.json ./dist/config/

# Copy paper caliper configuration
COPY src/config/paper-caliper.json ./dist/config/

# Copy local ICC profiles to the container
COPY icc-profiles/ /app/icc-profiles/

# Set environment variables for PDF processing
ENV GHOSTSCRIPT_BINARY=gs
ENV TEMP_DIR=/tmp/mythoria-print
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV HOME=/home/mythoria

# Create non-root user for security
RUN groupadd -r mythoria && useradd -r -g mythoria mythoria

# Create home directory and necessary subdirectories for mythoria user
RUN mkdir -p /home/mythoria/.cache/puppeteer \
    && mkdir -p /home/mythoria/.local/share/applications \
    && mkdir -p /home/mythoria/.config

# Set ownership and permissions
RUN chown -R mythoria:mythoria /app /tmp/mythoria-print /home/mythoria
RUN chmod 755 /tmp/mythoria-print

# Use non-root user
USER mythoria

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "dist/index.js"]
