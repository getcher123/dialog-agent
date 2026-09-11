FROM node:24-alpine
WORKDIR /app
COPY backend/ ./backend/
COPY web/ ./web/
ENV HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "backend/server.mjs"]
