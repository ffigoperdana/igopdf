# IGO Node.js 22.23.4 security maintenance report

Validation date: 22 October 2026 (Asia/Jakarta). Starting revision: `921de7e18269751593a66c7ab8ea53682da4e3d3`. The starting working tree was clean.

## A. Files changed

| File | Reason |
| --- | --- |
| `Dockerfile` | Pin the frontend builder to `public.ecr.aws/docker/library/node:22.23.4-alpine`; keep the nginx runtime and every build argument unchanged. |
| `Dockerfile.nonroot` | Use the same verified Node image; generate the required CSP include before building, matching the main Dockerfile. The generated include is ignored by Git and was otherwise absent from a clean checkout. Preserve PUID/PGID and the entrypoint. |
| `backend/Dockerfile` | Pin both builder and production stages to `node:22.23.4-bookworm-slim`. |
| `package.json` | Declare the supported application Node range as `>=22.23.4 <23`. |
| `backend/package.json` | Raise the backend floor from `>=20.19.0` to `>=22.23.4 <23`. |
| `package-lock.json` | Synchronize only the root application engine metadata. |
| `backend/package-lock.json` | Synchronize only the root application engine metadata. |
| `.nvmrc` | Select exactly `22.23.4` for local development. |
| `.github/workflows/build-and-publish.yml` | Pin build/test tooling to `22.23.4`. |
| `.github/workflows/seo-audit.yml` | Pin audit/build tooling to `22.23.4`. |
| `.github/workflows/update-embedpdf-snippet.yml` | Pin tooling to `22.23.4` and move setup before the first npm/Corepack invocation. |
| `docs/contributing.md` | Document the supported runtime and exact development version. |
| `docs/self-hosting/docker.md` | Update the documented build image to match the application. |
| `docs/internal/node22-security-patch.md` | Record evidence, blockers, deployment preparation, and rollback instructions. |

The engine range permits subsequent security patches within Node 22; deployment and CI remain pinned to the requested exact patch. Neither lockfile was regenerated. Structural comparison against HEAD confirmed that every resolved dependency, package version, integrity hash, and third-party engine requirement is unchanged.

## B. Node.js versions and image verification

| Environment | Before | After / observed |
| --- | --- | --- |
| Backend builder | `node:20.19-bookworm-slim` | `node:22.23.4-bookworm-slim`; built builder reports `v22.23.4` |
| Backend production | `node:20.19-bookworm-slim` | `node:22.23.4-bookworm-slim`; built production image reports `v22.23.4` |
| PDF / DOCX workers | Shared old backend image | Both running test workers report `v22.23.4` |
| Migration / storage-init services | Shared old backend image | Same patched backend image; existing migration entrypoint ran against disposable PostgreSQL; storage-init commands unchanged |
| Frontend builder | ECR `node:20-alpine` | ECR `node:22.23.4-alpine`; built builder reports `v22.23.4` |
| Alternate frontend builder | ECR `node:20-alpine` | Same verified ECR `node:22.23.4-alpine` base; complete alternate image build passes |
| Main / alternate frontend runtime | nginx images | Unchanged; Node is not part of the static frontend runtime |
| Build/test CI | `20.19` | `22.23.4` |
| SEO / snippet CI | `20` | `22.23.4` |
| Developer workstation | `v24.16.0`, npm `11.13.0` | Not modified; target validation used Linux images with Node `v22.23.4`, npm `10.9.9` |

Before editing, `docker buildx imagetools inspect` verified both exact image tags and disposable `docker run --rm --network none IMAGE node --version` executions verified their contents. No registry fallback was needed.

Observed multi-platform index digests:

- Bookworm: `sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`.
- ECR Alpine: `sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`.

Local validation images: `igo-node22-backend:validation`, `igo-node22-frontend:validation`, and `igo-node22-nonroot:validation`. These are local test tags, not published release artifacts. Image builds were Linux/amd64; other architectures were not executed.

## C. Security impact and remaining findings

The [official v22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4/) and [October announcement](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) identify Node 22 fixes for DNS NUL handling (CVE-2026-105482), TLS non-canonical IP validation (CVE-2026-106069, CVE-2026-106072), Brotli memory corruption (CVE-2026-111497), HTTP keep-alive response handling (CVE-2026-105481), snapshot entropy caching (CVE-2026-106074), and permission-model realpath checks (CVE-2026-106073). The release also updates bundled security dependencies. These are upstream runtime fixes; application exploitability was not established.

The final backend reports OpenSSL `3.5.9` and 116 TLS trust roots. `NODE_TLS_REJECT_UNAUTHORIZED` is unset, and the observed LDAP certificate-validation default remains `true`. No TLS settings, authentication controls, scanner exclusions, or security rules were changed.

Independent `npm audit --json` runs using Node 22.23.4 returned exit code 1:

| Audit | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frontend, all dependencies | 1 | 18 | 13 | 8 | 40 |
| Backend, all dependencies | 4 | 8 | 10 | 0 | 22 |
| Backend, `--omit=dev` | 1 | 6 | 5 | 0 | 12 |

Counts represent npm's vulnerable package entries, not unique CVEs or confirmed reachable vulnerabilities. The backend production critical finding is `proxy-addr`; high entries include `drizzle-orm`, `multer`, `nanoid`, `nodemailer`, `postcss`, and `source-map-js`. Frontend critical findings include `handlebars`; the full package/severity inventory appears below. Frontend npm dependencies include build tooling and browser libraries, so this is not an assertion that every entry ships in nginx.

These findings predate this patch's unchanged dependency resolution. Node upgrades do not fix npm dependency vulnerabilities. They require separate assessment/remediation; no forced audit fixes or major dependency upgrades were performed.

Trivy is not installed locally. Image-level Node/OS/Python/application CVEs remain unverified here. The existing Trivy and CodeQL workflows and `.trivyignore` were preserved; they were not executed remotely or bypassed.

## D. Executed validation

Docker commands used escalated local-engine access after the sandbox denied the Docker named pipe. No production deployment command was executed. Test services used the dedicated network `igo-node22-921de7e`, no host ports, no production env files, and PostgreSQL on a disposable tmpfs.

| Executed command / check | Result |
| --- | --- |
| `git status --short`, version-reference inventory, documentation and deployment review | PASS; initially clean |
| `docker buildx imagetools inspect node:22.23.4-bookworm-slim` and the ECR Alpine tag | PASS |
| `docker run --rm --network none IMAGE node --version` for each base | PASS; `v22.23.4` |
| Baseline host `npm run build` in `backend` | PASS on workstation Node 24, before editing |
| Baseline host backend `npm run test:run -- --reporter=dot` | BLOCKED by sandbox networking: 11 pass, two mock ClamAV TCP connections fail with EACCES; rerun in Linux passes |
| `docker build --progress=plain -t igo-node22-backend:validation -f backend/Dockerfile backend` | PASS; clean builder and runtime dependency installations, TypeScript compile |
| `docker build --progress=plain --build-arg VITE_BUILD_ID=node22-validation -t igo-node22-frontend:validation -f Dockerfile .` | PASS; clean npm installation, TypeScript, Vite, security headers |
| `docker build --progress=plain --build-arg VITE_BUILD_ID=node22-validation -t igo-node22-nonroot:validation -f Dockerfile.nonroot .` | PASS; clean npm installation, frontend and documentation build, security headers |
| `docker build --target builder ...` for backend and frontend test images | PASS; both built builders report `v22.23.4` |
| `docker run --rm --network none ... igo-node22-backend-builder:validation npm run test:run -- --reporter=dot` | PASS; 13/13, including mocked ClamAV TCP tests |
| `docker run --rm --network none igo-node22-frontend-builder:validation npm run test:run -- --reporter=dot` | FAIL; 871 pass, 11 fail across 49 files |
| Same frontend command with the ten test paths from `build-and-publish.yml` | PASS; 104/104 across ten files |
| `docker run --rm --network none igo-node22-backend:validation python3 dist/scripts/docx_convert_test.py` | PASS; 23/23 on final image |
| `docker run --rm --network none igo-node22-frontend-builder:validation npm run lint` | FAIL; 408 errors, 18,556 warnings, including unchanged source and generated/vendor files |
| Same builder `npm run lint:security` | FAIL; 585 errors, 18,380 warnings; original rules retained |
| Backend builder `npm run lint` | BLOCKED; backend context has no standalone ESLint config |
| Frontend repository builder with `-w /app/backend`, `npm run lint` | FAIL; one error and 19 warnings; root config available |
| Frontend builder `npm run seo-audit` | FAIL; 22 canonical/noindex/sitemap findings |
| Separate frontend/backend `npm audit --json --cache /tmp/npm`, and backend `--omit=dev` | FAIL; findings above; read-only repository mounts |
| `docker compose --env-file NUL -f FILE config --quiet` for local, development and production files | PASS; explicit nonproduction placeholder environment |
| `sh -n /validation/deploy.sh` inside Node Bookworm with read-only deploy mount | PASS |
| Final backend `node --version`, `id`, argon2 hash/verify and TLS defaults | PASS; `v22.23.4`, UID/GID 10001, native argon2 works |
| Frontend builder sharp PNG creation | PASS; native image processing on `v22.23.4` |
| `qpdf --version`, `gs --version`, `tesseract --list-langs` | PASS; qpdf 11.3.0, Ghostscript 10.00.0; eng, ind, osd available |
| Generate sample PDF, process with qpdf and Ghostscript, `qpdf --check` both outputs | PASS |
| Generate sample PNG and `tesseract ... stdout -l eng+ind` | PASS; recognized sample text |
| Disposable DB `pg_isready`; existing `dist/scripts/migrate.js` and `seed.js` | PASS against test database only |
| Built API and both worker entrypoints with test DB | PASS; startup logged, processes stayed running, zero restarts |
| Executing `node --version` in both running workers | PASS; `v22.23.4` |
| Isolated HTTP/native smoke script | PASS; health, CAPTCHA, admin/user login, profile, HttpOnly/Secure/SameSite=Strict cookie, RBAC 403, logout invalidation, frontend CSP/COOP and service-worker cache headers |
| Production `deploy/nginx.conf` in disposable proxy container | PASS; frontend and CAPTCHA API routing plus isolation headers |
| Main frontend `nginx -t`, static/PWA assets and build marker | PASS; runtime UID 101, `sw.js` and `version.json` present |
| Alternate runtime `PUID=1234 PGID=1234`, `id` assertions and `nginx -t` | PASS; entrypoint drops to requested UID/GID |
| Disposable backend root `install -d -o 10001 -g 10001 -m 0700 ...`, `stat` | PASS; both application storage paths retain owner 10001:10001 and mode 700 |
| Lockfile structural comparison and `git diff --check` | PASS; only application engine metadata changed in locks |
| Active source/workflow/doc Node-20 pin search | PASS; none remain (historical before-values in this report excluded) |
| Trivy, remote CodeQL, real AD/LDAPS/SMTP integration, browser end-to-end offline/Office/signing/upload job flows | BLOCKED / not run; unavailable scanner/external test systems/browser integration fixtures |

Full frontend test failures are accounted for by unchanged repository content: nine assertions in `src/tests/i18n.test.ts` expect languages such as de/fr/vi or URL language selection, whereas existing IGO code supports id/en and deliberately ignores URL language prefixes. Two tests in `split-pdf-helpers.test.ts` require absent `shared-resources.pdf` and `bookmarked.pdf`; only `sample.pdf` is tracked. The backend repository lint error is the existing namespace in `backend/src/middleware/auth.ts:8`. None of these tests, language behaviors, fixtures, or lint rules was changed.

Disposable validation containers and their isolated network were removed after testing; local validation images were retained. Detailed local outputs are retained under the ignored `tmp/` directory, including audit JSON and build/test logs. The smoke script's first attempt used an incorrect `/api/users` route and returned 404; after correcting the harness to `/api/admin/users`, all smoke assertions passed. This required no application change.

## E. Compatibility findings

- Installed backend argon2 0.41.x loads and hashes/verifies on Node 22 without dependency changes. Frontend native sharp and the Vite/Tailwind build also work.
- Bookworm packages, Python requirements, OCR languages, file ownership, UID/GID 10001, entrypoints, and API/worker commands are unchanged. Python emits an existing `fitz` deprecation warning; DOCX tests still pass. Python transitive dependencies are not fully pinned by the existing requirements file, so future builds can resolve differently.
- Existing WASM build warnings about direct eval and a deprecated Vite plugin option remain; builds pass. No PDF/OCR algorithm, browser feature, branding, UI, localization, PWA policy, or asset URL was intentionally altered.
- Production Compose still shares `${IGO_BACKEND_IMAGE}` across backend, migrate, pdf-worker, docx-worker and storage-init. The one-shot storage initializer retains its intentional root override; application processes remain non-root. PostgreSQL 16, volumes, resource limits, networks, dependencies and routing are unchanged.
- `deploy/deploy.sh` remains compatible: it pulls images, starts PostgreSQL, runs migrations, initializes storage, optionally seeds, starts services and restarts nginx to refresh upstream DNS. Because it always invokes migrations, use the runtime-only rollout below when the existing schema/storage is already initialized.
- The alternate Dockerfile is actively documented in `docs/self-hosting/docker.md`; its nginx runtime still starts through the existing root bootstrap and drops to PUID/PGID.

## F. Deployment readiness

**BLOCKED — REQUIRES FIXES**

The requested runtime patch builds and passes targeted compatibility checks. Existing full-suite failures, lint/security-lint failures and dependency audit findings prevent claiming all quality/security gates pass. Image vulnerability scans and real directory/mail/browser integration validation are outstanding. Resolve or formally assess these blockers through the normal security/release process without disabling gates, then validate in staging. No production readiness claim is made.

## G. Safe deployment preparation and rollback

These are operator instructions only. They have not been executed against production.

### Preparation and staging gates

1. Record the existing production Git revision, image references and immutable digests for frontend and every backend-image consumer. Work from the actual production Compose project directory/name; changing the project name can select different volumes.
2. Verify an available PostgreSQL backup, restore procedure, and recovery ownership before maintenance. Back up `.env.prod`, Compose files, nginx config and any mounted certificate/config files into an access-restricted location outside this checkout. Preserve the database and application volumes. Do not print credentials into logs.
3. Review the existing quality/audit blockers above and require the normal CI, Trivy and CodeQL gates plus staging functional checks to pass. This report does not authorize bypassing them.
4. Build new immutable images from the reviewed revision, using the same production build arguments and BuildKit secrets. Example from repository root (publishing remains a separately authorized operator action):

   ```sh
   REV=$(git rev-parse HEAD)
   OWNER=ffigoperdana
   FRONTEND="ghcr.io/$OWNER/igov2-frontend:node22.23.4-$REV"
   BACKEND="ghcr.io/$OWNER/igov2-backend:node22.23.4-$REV"
   docker build --pull --build-arg "VITE_BUILD_ID=$REV" -t "$FRONTEND" -f Dockerfile .
   docker build --pull -t "$BACKEND" -f backend/Dockerfile backend
   docker run --rm --network none "$BACKEND" node --version
   docker run --rm --network none "$BACKEND" id
   ```

   Include all deployment-specific build arguments/secrets used by the previous frontend build; defaults alone may not reproduce production configuration. Do not overwrite known-good release tags. After authorized publishing, record the registry digests and pin production image variables to `ghcr.io/...@sha256:...`.
5. On staging with disposable data, repeat backend/worker version and UID checks, login/LDAP/LDAPS provisioning, CAPTCHA, sessions/RBAC, SMTP, PDF merge/split/compression, DOCX/Office/OCR, signing/editing, large/chunked uploads, downloads, jobs/status, id/en themes and PWA/offline smoke tests. Check certificate chains under Node 22's updated trust store without disabling verification.

### Production recording and runtime-only rollout after approval

From the existing production `deploy/` directory, keep the current Compose project selection:

```sh
dc() { docker compose --env-file .env.prod -f docker-compose.prod.yml "$@"; }
# Choose a restricted backup directory outside the repository before proceeding.
BACKUP_DIR=/secure/igo-node22-backup-20261022
install -d -m 0700 "$BACKUP_DIR"
cp -p .env.prod "$BACKUP_DIR/env.prod"
cp -p docker-compose.prod.yml nginx.conf "$BACKUP_DIR/"
git -C .. rev-parse HEAD > "$BACKUP_DIR/git-revision.txt"
dc config --images > "$BACKUP_DIR/image-references.txt"
for service in frontend backend pdf-worker docx-worker; do
  id=$(dc ps -q "$service")
  docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' "$id"
  image=$(docker inspect --format '{{.Image}}' "$id")
  docker image inspect --format '{{json .RepoDigests}}' "$image"
done > "$BACKUP_DIR/running-image-digests.txt"
```

Also record migrate/storage-init image references from the existing configuration and retain both known-good image digests in a rollback copy of the environment file. Confirm PostgreSQL backup/recovery separately; copying configuration is not a database backup.

Only after approval and required gates pass, edit just `IGO_FRONTEND_IMAGE` and `IGO_BACKEND_IMAGE` in `.env.prod` to the approved immutable digests. Then:

```sh
dc config --quiet
dc pull frontend backend pdf-worker docx-worker
# Preconditions: existing schema is current and storage permissions already match
# the unchanged UID 10001 contract. No schema changes are part of this patch.
dc up -d --no-deps backend pdf-worker docx-worker frontend
dc restart nginx
dc ps
for service in backend pdf-worker docx-worker; do
  dc exec -T "$service" node --version
  dc exec -T "$service" id
done
dc logs --tail=100 backend pdf-worker docx-worker nginx
```

The runtime-only command avoids automatically starting migrate/storage-init or touching PostgreSQL. Do not use it for an uninitialized installation. A schema/ownership discrepancy requires separate investigation before rollout. The nginx restart retains the deployment script's upstream-DNS refresh behavior.

After rollout, confirm external HTTPS availability and nginx routing, test local and AD login/RBAC/CAPTCHA, upload/download, PDF/DOCX/OCR jobs, languages/themes and offline update behavior. Verify the expected PWA build marker. Watch API/worker logs, failed jobs, restarts, request latency and error rates during the maintenance window. Do not log secrets or document contents.

### Rollback

1. Restore only `IGO_FRONTEND_IMAGE` and `IGO_BACKEND_IMAGE` to the recorded previous known-good **digests**; preserve any unrelated configuration changes made since the backup. All backend-image consumers then refer to the same rollback backend image.
2. Revalidate, pull and recreate only application services, then restart nginx:

   ```sh
   dc config --quiet
   dc pull frontend backend pdf-worker docx-worker
   dc up -d --no-deps backend pdf-worker docx-worker frontend
   dc restart nginx
   dc ps
   dc logs --tail=100 backend pdf-worker docx-worker nginx
   ```

3. Recheck availability, authentication, workers, routing and error rates. A rollback to Node 20 restores its prior runtime vulnerability exposure; coordinate security follow-up.
4. Do not run migrations, reset the database, restore database contents automatically, delete volumes, or use volume-removal/prune commands. No schema migration is needed for this runtime patch. Retain backups and evidence until recovery is confirmed.

## H. Final scope

Only version policy/pins, associated tooling/documentation and the alternate builder's missing security-header generation were changed. No application source, runtime nginx image, Compose topology, deployment script, credentials, LDAP settings, persistent volumes, schema, security exclusions or dependency resolutions were changed. No existing feature behavior was intentionally changed. No commit, push, merge, release or production deployment was performed.

## Audit package inventory

The following inventories come from the independent audit JSON outputs on the validation date. Advisory applicability needs separate assessment; the runtime patch does not resolve these entries.

### Frontend (all dependencies)

| Package | Severity | Direct dependency |
| --- | --- | --- |
| `@humanfs/node` | moderate | no |
| `@vitest/coverage-v8` | moderate | yes |
| `@vitest/mocker` | moderate | no |
| `@vitest/ui` | moderate | yes |
| `@vue/server-renderer` | high | no |
| `brace-expansion` | high | no |
| `braces` | high | no |
| `browserify-sign` | low | no |
| `chokidar` | high | no |
| `create-ecdh` | low | no |
| `crypto-browserify` | low | no |
| `devalue` | high | no |
| `dompurify` | moderate | yes |
| `elliptic` | low | no |
| `fflate` | moderate | no |
| `follow-redirects` | high | no |
| `handlebars` | critical | no |
| `i18next-http-backend` | low | yes |
| `katex` | low | no |
| `linkify-it` | high | no |
| `markdown-it` | high | yes |
| `mermaid` | moderate | yes |
| `nanoid` | high | no |
| `node-forge` | high | yes |
| `node-stdlib-browser` | low | no |
| `pbkdf2` | moderate | no |
| `postcss` | high | no |
| `qs` | moderate | no |
| `sharp` | high | yes |
| `source-map-js` | high | no |
| `undici` | high | no |
| `uuid` | moderate | no |
| `vite` | high | yes |
| `vite-plugin-handlebars` | moderate | yes |
| `vite-plugin-node-polyfills` | low | yes |
| `vite-plugin-static-copy` | high | yes |
| `vitepress` | moderate | yes |
| `vitest` | moderate | yes |
| `vue` | high | yes |
| `zgapdfsigner` | high | yes |

### Backend (all dependencies)

| Package | Severity | Direct dependency |
| --- | --- | --- |
| `@esbuild-kit/core-utils` | moderate | no |
| `@esbuild-kit/esm-loader` | moderate | no |
| `@vitest/mocker` | moderate | no |
| `body-parser` | moderate | no |
| `brace-expansion` | high | no |
| `csv-parse` | moderate | yes |
| `drizzle-kit` | moderate | yes |
| `drizzle-orm` | high | yes |
| `esbuild` | moderate | no |
| `express` | moderate | yes |
| `multer` | high | yes |
| `nanoid` | high | no |
| `nodemailer` | high | yes |
| `postcss` | high | no |
| `proxy-addr` | critical | no |
| `qs` | moderate | no |
| `sanitize-html` | moderate | yes |
| `shell-quote` | critical | no |
| `source-map-js` | high | no |
| `tinypool` | critical | no |
| `vite` | high | no |
| `vitest` | critical | yes |

### Backend (production dependencies)

| Package | Severity | Direct dependency |
| --- | --- | --- |
| `body-parser` | moderate | no |
| `csv-parse` | moderate | yes |
| `drizzle-orm` | high | yes |
| `express` | moderate | yes |
| `multer` | high | yes |
| `nanoid` | high | no |
| `nodemailer` | high | yes |
| `postcss` | high | no |
| `proxy-addr` | critical | no |
| `qs` | moderate | no |
| `sanitize-html` | moderate | yes |
| `source-map-js` | high | no |

