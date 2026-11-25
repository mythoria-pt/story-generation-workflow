# Use Debian slim (glibc) for build stage to match runtime environment
# and ensure native binaries (e.g. sharp) are compiled for the correct libc
ARG NODE_VERSION=24.18.1
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Skip Puppeteer browser download during npm ci — Chrome is installed in the runtime stage
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json .npmrc ./
COPY compat/ ./compat/

# Install ALL dependencies first (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev --ignore-scripts

# Production stage with Debian-based image for Ghostscript support
FROM node:${NODE_VERSION}-bookworm-slim

# Keep the xdg-utils man page required by its open alternative on Debian slim.
# Configure Chrome with Google's published primary key scoped to its HTTPS repository.
RUN printf '%s\n' 'path-include /usr/share/man/man1/xdg-open.1.gz' > /etc/dpkg/dpkg.cfg.d/zz-xdg-open \
    && apt-get update && apt-get install -y \
    ffmpeg \
    poppler-utils \
    icc-profiles-free \
    ghostscript \
    ca-certificates \
    wget \
    && install -d -m 0755 /etc/apt/keyrings \
    && wget -q -O /etc/apt/keyrings/google-chrome.asc https://dl.google.com/linux/linux_signing_key.pub \
    && chmod 0644 /etc/apt/keyrings/google-chrome.asc \
    && printf '%s\n' \
      'Types: deb' \
      'URIs: https://dl.google.com/linux/chrome/deb/' \
      'Suites: stable' \
      'Components: main' \
      'Architectures: amd64' \
      'Signed-By: /etc/apt/keyrings/google-chrome.asc EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796' \
      > /etc/apt/sources.list.d/mythoria-chrome.sources \
    && printf '%s\n' 'repo_add_once="false"' 'repo_reenable_on_distupgrade="false"' > /etc/default/google-chrome \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-liberation2 fonts-dejavu-core fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && test -r /usr/share/man/man1/xdg-open.1.gz \
    && rm -rf /var/lib/apt/lists/*

# Gemini TTS conversion and audiobook mixing require a modern amix filter.
RUN ffmpeg -hide_banner -h filter=amix 2>&1 | grep -q 'normalize'

# Paid Lulu proofs use the Debian sRGB profile and Poppler inspection tools.
RUN test -r /usr/share/color/icc/sRGB.icc && command -v pdffonts && command -v pdfimages

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
COPY print-assets/ /app/print-assets/

# Copy background music files from the built dist folder
COPY --from=builder /app/dist/backgroundMusics ./dist/backgroundMusics

# Set environment variables for PDF processing
ENV GHOSTSCRIPT_BINARY=gs
ENV FFMPEG_BINARY=/usr/bin/ffmpeg
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
