# IGO Node.js 22.23.4 PR CI blocker fixes

Date: 23 October 2026 (Asia/Jakarta). Branch: `security/node-22.23.4`. Starting revision: `d9ef14e` (`fix(security): upgrade Node.js to 22.23.4 LTS`). The working tree was clean before these fixes.

## Root causes and minimal fixes

### Docker registry

The reported `docker-build-check` failure is an HTTP 429 from the public ECR registry while resolving the frontend builder base image. It is a registry access failure, not a Node/application build incompatibility.

Both frontend Dockerfiles now use the verified official image:

```text
docker.io/library/node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
```

`docker buildx imagetools inspect docker.io/library/node:22.23.4-alpine` confirmed that multi-platform index digest. Its Linux/amd64 manifest is `sha256:025b8e975a61d94e33abeafaad1255ef44e4898cf1a1b6446860009c72e6d284`. A disposable container reports `v22.23.4`. The index digest matches the ECR image verified during the original patch, so the registry change preserves the image contents and pins them immutably. It removes the ECR dependency; Docker Hub availability/rate limits still depend on the runner and registry. No unverified mirror or credentials were introduced.

The backend already uses official Docker Hub `node:22.23.4-bookworm-slim` for both stages and needed no change. `.github/workflows/build-and-publish.yml` also needed no change: it builds these Dockerfiles, uses Node 22.23.4, and intentionally skips publishing on pull requests. nginx runtime images, build arguments, secret mounts, native packages, security-header generation and ownership remain intact.

### SEO configuration and internal-site policy

There were three independent mismatches:

1. The SEO workflow sets `SITE_URL=https://igo.example.go.id`, a CI placeholder rather than the actual domain.
2. HTML source metadata contains literal `https://igo.local` URLs. Vite previously did not consume `SITE_URL` for these tags, so setting the environment alone could not rewrite them. The main Dockerfile also defaulted to `igo.local`, while the alternate defaulted to the upstream BentoPDF domain.
3. The inherited SEO audit assumes a public marketing site. It rejects deliberate `noindex` on internal pages, requires canonicals on excluded/login/admin pages, and requires a public sitemap. IGO instead ships `User-agent: *` / `Disallow: /`, intentionally excludes its internal pages from indexing, and does not generate language-prefixed static pages or a sitemap in `npm run build`.

The workflow, both Docker defaults and audit now agree on `https://igo.bpdp.or.id`. A small build-only Vite plugin resolves the local placeholder only in canonical, Open Graph URL and Twitter URL metadata, using `SITE_URL` or that default. It does not rewrite navigation, routes, languages, branding, page content or indexing directives.

The audit stays enabled and has narrowly documented internal-page policy:

- Require existing `noindex` on the explicitly listed internal/excluded pages. No directives were removed from HTML.
- Keep canonicals optional only for those explicitly excluded pages; validate them normally whenever present. Tool pages still require correct canonicals.
- Require crawl-blocking `robots.txt`, including protection against Allow exceptions or crawler-specific overrides.
- Permit an absent public sitemap because this internal build does not generate one. If a sitemap is supplied, retain URL/host/duplicate/size checks and additionally reject excluded internal pages.
- Retain title, hreflang-host, empty translation-span and structured-rating checks, and reject unexpected tool-page noindex directives.

Nine regression tests exercise positive and negative cases, including wrong canonical hosts, missing noindex, missing robots, crawl-permitting overrides, and private-page sitemap entries. The SEO workflow runs those tests before the artifact audit and now triggers when its policy tests, robots file or workflow change.

`scripts/generate-i18n-pages.mjs` and `scripts/generate-sitemap.mjs` were inspected but are not part of the active build command. They retain upstream public-site/localized-page assumptions and were deliberately not enabled or rewritten: doing so would change IGO routing, language behavior and generated branding. The active build/audit no longer relies on them.

## Exact files modified

| File | Change |
| --- | --- |
| `Dockerfile` | Official Docker Hub Node tag plus verified digest; actual IGO SITE_URL default. |
| `Dockerfile.nonroot` | Same registry/digest and SITE_URL changes. |
| `.github/workflows/seo-audit.yml` | Actual domain, audit-policy regression step, relevant path triggers. |
| `vite.config.ts` | Build-only placeholder resolution for canonical/social URL metadata. |
| `scripts/seo-audit.mjs` | IGO internal-page/crawl-blocking policy, consistent URL default, optional fixture output directory for tests. |
| `scripts/seo-audit.test.mjs` | Nine focused audit-policy regression tests. |
| `docs/self-hosting/docker.md` | Keep the documented builder image consistent with the verified Docker Hub source. |
| `docs/internal/node22-ci-blockers.md` | This evidence, manual CLA procedure and PR update instructions. |

No package manifest, lockfile, backend source, worker, database, LDAP/RBAC/login/session logic, HTML indexing directive, robots file, nginx configuration, production configuration, CLA signature or CLA workflow was changed.

## Validation results

Tests used local Linux/amd64 Docker images under Node.js 22.23.4. Test containers used `--rm` and external networking was disabled for regression execution. No database or production service was contacted. Local output logs are retained under ignored `tmp/node22-ci-*.log`.

| Executed command / check | Result |
| --- | --- |
| `git branch --show-current`, `git status --short` | PASS: required branch; initially clean. |
| `docker buildx imagetools inspect docker.io/library/node:22.23.4-alpine` | PASS: official multi-platform digest confirmed. |
| `docker run --rm --network none docker.io/library/node:22.23.4-alpine node --version` | PASS: `v22.23.4`. |
| `docker build --progress=plain --build-arg VITE_BUILD_ID=node22-ci-validation --build-arg SITE_URL=https://igo.bpdp.or.id -t igo-node22-ci-frontend:validation -f Dockerfile .` | PASS: frontend TypeScript/Vite build and production image. |
| Same frontend Docker build with `--target builder`, tagged `igo-node22-ci-frontend-builder:validation` | PASS: test builder exported. |
| `docker build --progress=plain --build-arg SITE_URL=https://igo.bpdp.or.id -t igo-node22-ci-nonroot:validation -f Dockerfile.nonroot .` | PASS: alternate frontend/docs build and image. |
| `docker build --progress=plain -t igo-node22-ci-backend:validation -f backend/Dockerfile backend` | PASS: backend production image (unchanged build layers cached). |
| Backend `--target builder`, tagged `igo-node22-ci-backend-builder:validation` | PASS. |
| `docker run --rm --network none igo-node22-ci-backend-builder:validation npm run build` | PASS: TypeScript explicitly rerun independently of build cache. |
| `docker run --rm --network none ... igo-node22-ci-backend-builder:validation npm run test:run -- --reporter=dot` | PASS: 13 tests across three files, including mocked ClamAV connections. |
| Frontend builder `npm run test:run --` with the ten existing `build-and-publish.yml` test paths | PASS: 104 tests across ten files. |
| `docker run --rm --network none igo-node22-ci-backend:validation python3 dist/scripts/docx_convert_test.py` | PASS: 23 DOCX tests. Existing fitz deprecation warning remains. |
| Frontend builder `npm run seo-audit` with `SITE_URL=https://igo.bpdp.or.id` | PASS: all 129 built HTML pages; IGO metadata and crawl-blocking policy verified. |
| Frontend builder `node --test scripts/seo-audit.test.mjs` | PASS: 9/9. Also passed directly on the workstation. |
| Frontend builder `npx --no-install eslint scripts/seo-audit.mjs scripts/seo-audit.test.mjs vite.config.ts` | PASS: existing rules, no exclusions added. |
| `docker compose --env-file NUL -f FILE config --quiet` for local, development and production Compose | PASS: test-only DB/session/image/CORS placeholders; no services started. |
| `node --version` in both built builders and final backend image | PASS: all report `v22.23.4`. |
| Backend production argon2 hash/verify and UID assertion | PASS: native module works; UID 10001. |
| Frontend production `nginx -t`, UID assertion and artifact checks | PASS: UID 101, actual-domain metadata, retained login noindex/robots blocking, CSP and service-worker assets. |
| Alternate runtime `PUID=1234 PGID=1234`, UID/GID assertions, `nginx -t`, metadata/noindex checks | PASS. |
| Final diff/branch checks | PASS: focused scope; no dependency version changes. |
| GitHub-hosted rerun and CLA signing/status confirmation | PENDING: no changes pushed; contributor must sign personally. Remote live diagnostics were not available in this session. |

The changed audit script was mounted read-only into the frontend test image for final tests, ensuring the latest working-tree audit was exercised against the freshly built artifacts. Build warnings from existing WASM/Vite dependencies remain and were not suppressed.

The earlier migration report's unrelated full-suite/lint/dependency-audit findings are outside this CI-blocker change. No tests, scanners, CI jobs or rules were disabled to hide those findings. This validation is not a claim that all application/image vulnerabilities are resolved.

## CLA Assistant: exact manual procedure

The reported signature-required failure is the expected result for an unsigned contributor. The existing workflow uses `pull_request_target` and PR `issue_comment` events, filters for the exact signature or `recheck`, links `main/ICLA.md`, and stores signatures in `signatures/cla.json` on `main`. Its inputs and events match the pinned [CLA action definition](https://raw.githubusercontent.com/contributor-assistant/github-action/v2.6.1/action.yml) and [upstream signing instructions](https://github.com/contributor-assistant/github-action/tree/v2.6.1#3-signing-the-cla). No workflow defect is confirmed by the supplied signature-required result.

Manual steps for each contributor named by the CLA bot:

1. Sign into GitHub as that contributor and open the existing PR from `security/node-22.23.4` into `main`.
2. Read the linked [ICLA](https://github.com/ffigoperdana/igopdf/blob/main/ICLA.md) and the bot's comment. The checked-in document still identifies the upstream BentoPDF project while the bot text describes IGO/BPDP maintenance. The owner should resolve any intended governance/document mismatch before agreeing; no legal document was altered here. Corporate contributors should follow the linked [CCLA](https://github.com/ffigoperdana/igopdf/blob/main/CCLA.md) procedure where applicable.
3. If the contributor agrees and is authorized, post a new PR conversation comment containing exactly this one line, without a quote marker or code fence:

   ```text
   I have read the CLA Document and I hereby sign the CLA
   ```

4. Wait for CLA Assistant to record the signature and recheck the PR. If it needs a recheck, post a separate new comment containing exactly `recheck`. Every contributor identified as unsigned must complete the process from their own account.
5. If the signature comment fails to persist or the check reports a permissions/storage error, the repository maintainer must inspect that run. The action stores on `main`; its [configuration guidance](https://github.com/contributor-assistant/github-action/tree/v2.6.1#configure-contributor-license-agreement-within-two-minutes) says the signature branch should not be protected against its writes. Branch rules, token access and the configured `CLA_ASSISTANT_TOKEN` could not be verified locally. Do not weaken branch protection or fabricate/edit signatures to bypass the failure; any storage/permission configuration change needs separate repository-owner review.

No CLA was signed, no PR comment was posted, and no signature or allowlist was manufactured or modified. The existing workflow does not check out or execute PR application code with its write token; that separation was preserved.

## Updating the existing PR

The technical fixes are locally validated. The remaining required actions are a reviewed commit/push by the operator, a GitHub-hosted rerun and the contributor's manual CLA agreement. Publishing remains correctly skipped on a PR. Nothing in this task authorizes merging or deploying.

Review the diff, then run these commands yourself when ready (they were **not** executed by this agent):

```sh
git branch --show-current
# Must print security/node-22.23.4.
git diff --check
git diff --stat
git add Dockerfile Dockerfile.nonroot .github/workflows/seo-audit.yml vite.config.ts scripts/seo-audit.mjs scripts/seo-audit.test.mjs docs/self-hosting/docker.md docs/internal/node22-ci-blockers.md
git diff --cached
git commit -m "fix(ci): stabilize Node 22 image pulls and IGO SEO validation"
git push origin security/node-22.23.4
```

Pushing that same branch updates the existing PR; do not open a replacement PR or merge into `main`. Verify `build-test`, `docker-build-check`, SEO audit and CLA status on the new head revision. Keep publishing skipped for the PR. If registry infrastructure still fails, distinguish the reported registry/HTTP error from application build failures rather than downgrading Node or bypassing checks.

Production was not modified. There was no commit, push, merge, release, production deployment, migration or production configuration/database access during this task.
