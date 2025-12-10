FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install dependencies into temp directory
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lockb* /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

# Expose port
EXPOSE 5000

# Set environment
ENV NODE_ENV=production
ENV PORT=5000

# Run the app
CMD ["bun", "chatwhats.js"]
