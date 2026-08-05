# ── Stage 1: Build backend ────────────────────────────────────────────────────
FROM node:22-alpine AS backend-build
# The Roon dependencies are vendored in the repository (Roon Labs doesn't
# publish them to npm), so the build needs no git and no network fetches
# beyond the npm registry.
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY vendor/ vendor/
COPY src/ src/
RUN npm ci && npm run build

# ── Stage 2: Build frontend ──────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build
# This stage has no .git, so the UI build cannot ask git for the
# revision it stamps into kit.version.name. Pass it in:
#   docker build --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) …
# Without it the build falls back to a unique per-build stamp (never a
# constant — SvelteKit uses the value for stale-deployment detection).
ARG SOURCE_COMMIT=
ENV PUBLIC_BUILD_REV=${SOURCE_COMMIT}
WORKDIR /build
# Frontend has no Roon deps, so no git is needed.
COPY src/shared/ src/shared/
COPY ui/ ui/
WORKDIR /build/ui
RUN npm ci && npm run build

# ── Stage 3: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/ vendor/
RUN npm ci --omit=dev

COPY --from=backend-build /build/dist/ dist/
COPY --from=frontend-build /build/ui/build/ ui/build/

RUN mkdir -p config data/image-cache

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333

EXPOSE 3333

CMD ["node", "dist/index.js"]
