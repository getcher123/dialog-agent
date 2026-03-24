FROM node:24 AS build
WORKDIR /app

COPY package.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json

RUN npm install

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV FRONTEND_DIST_PATH=/app/frontend/dist

EXPOSE 3000

WORKDIR /app/backend
CMD ["node", "dist/server.js"]

