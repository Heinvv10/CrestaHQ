# The mystery shop's website-form engine: one disposable container per job
# (lib/prospecting/mystery-shop/form/container.ts). Built by
# scripts/form-engine-image.mjs, which stages dist/ (the bundled runner and
# playwright-core) and tags the image by content. The base image ships the
# Chromium build matching this playwright version; keep the three pinned
# together (package.json: @playwright/test, playwright-core).
FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY dist/ /app/
# The root filesystem is read-only at run time: Chromium's config and crash
# databases go to the /tmp and /home/pwuser tmpfs mounts (without them it
# dies at launch: "chrome_crashpad_handler: --database is required").
ENV NODE_ENV=production HOME=/home/pwuser XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache
USER pwuser
ENTRYPOINT ["node", "/app/runner.mjs"]
