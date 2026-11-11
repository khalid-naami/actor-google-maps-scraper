FROM apify/actor-node-playwright:22-1.65.0

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY . ./

ENV CRAWLEE_PURGE_ON_START=0

CMD ["npm", "start"]
