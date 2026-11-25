FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npx playwright install --with-deps chromium
# tini runs as PID 1 and reaps the chrome-headless-shell processes Playwright
# leaves behind. Without it they pile up as zombies until the container hits its
# process limit and every render fails with "spawn EAGAIN" / "browser has been closed".
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
EXPOSE 43123

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
