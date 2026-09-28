FROM node:20-alpine
# Pinned: server.js depends on specific CLI flags (--append-system-prompt,
# --allowedTools, --exclude-dynamic-system-prompt-sections, --output-format,
# --max-turns). An unpinned install could change them on any rebuild.
# 2.1.197 is the version running in production (2026-09-27); bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.197
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
# Create creds directory
RUN mkdir -p /root/.claude
# Simple refresh loop script
COPY refresh.sh /refresh.sh
RUN chmod +x /refresh.sh
CMD ["/refresh.sh"]
