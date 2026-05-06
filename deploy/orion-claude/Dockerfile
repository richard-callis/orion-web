FROM node:20-alpine

# Install claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create claude home — credentials volume will be mounted here
RUN mkdir -p /root/.claude

WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./

EXPOSE 3100
CMD ["node", "server.js"]
