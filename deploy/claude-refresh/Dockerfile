FROM node:20-alpine
RUN npm install -g @anthropic-ai/claude-code
# Create creds directory
RUN mkdir -p /root/.claude
# Simple refresh loop script
COPY refresh.sh /refresh.sh
RUN chmod +x /refresh.sh
CMD ["/refresh.sh"]
