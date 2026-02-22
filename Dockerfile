# ---- Builder Stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Copy package files first for better caching
COPY package*.json tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# ---- Production Stage ----
FROM node:24-alpine
WORKDIR /app

# Install runtime dependencies (Alpine uses apk)
RUN apk add --no-cache \
    ca-certificates \
    curl \
    iproute2 \
    tini

# Copy package files and install ONLY production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built code from builder
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN adduser -D -u 1001 appuser && \
    chown -R appuser:appuser /app
USER appuser

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Default command
CMD ["node", "dist/app.js"]