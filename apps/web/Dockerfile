# syntax=docker/dockerfile:1
# Vibe 1099 web — static SPA behind nginx, proxying /api and /auth to the api container (port 8211)
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json .npmrc ./
# @kisaesdevlab/vibe-auth (single sign-on) comes from GitHub Packages. The token
# arrives as a BuildKit secret and is written to a throwaway npmrc that never
# lands in a layer:  docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN …
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && pnpm install \
 && rm -f /root/.npmrc
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ src/
RUN pnpm build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8211
