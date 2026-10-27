# Playwright + Chrome image. The tag pins the Node.js major version; the
# image ships a matching Playwright, which package.json picks up via "*".
FROM apify/actor-node-playwright-chrome:22

# Install production dependencies first so Docker can cache this layer.
# Only package.json is copied (no lockfile) so that "playwright": "*" keeps the
# Playwright version preinstalled in the image, which matches its browser.
COPY --chown=myuser package.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser . ./

CMD ["npm", "start", "--silent"]
