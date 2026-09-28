FROM node:20-alpine

# node-pty requires native compilation
RUN apk add --no-cache python3 make g++ libc6-compat

# Install claude CLI globally
# Pinned: server.js depends on specific CLI flags (--append-system-prompt,
# --allowedTools, --exclude-dynamic-system-prompt-sections, --output-format,
# --max-turns). An unpinned install could change them on any rebuild.
# 2.1.197 is the version running in production (2026-09-27); bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.197
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Create claude home — credentials volume will be mounted here
RUN mkdir -p /root/.claude

WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js prompt.js ./

EXPOSE 3100
CMD ["node", "server.js"]
