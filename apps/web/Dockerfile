# Vibe 1099 web — static SPA behind nginx, proxying /api to the api container (port 8211)
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ src/
RUN pnpm build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8211
