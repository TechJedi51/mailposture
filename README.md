# MailPosture with Dockhand

MailPosture is a generic, read-only status page for DMARC, parsedmarc aggregate results, DKIM, MTA-STS, TLS-RPT, TLS certificates, and BIMI. It contains no user-specific domain configuration. Operational settings are entered in the web UI and saved in a named Docker volume; Dockhand supplies only deployment and OpenSearch connection values.

## Included files

```text
mailposture/
├── .github/workflows/       # Tests and publishes the image to GHCR
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── server.js
├── public/
└── test/
```

No host bind mount is required. Docker stores `/data/settings.json` in the `mailposture_data` named volume so image updates do not erase it.

## Settings screen

After the first deployment, open **Settings** in MailPosture and enter the following values.

### Domains

Use one domain per line:

```text
example.com
example.net
```

### DKIM selectors

Use one domain mapping per line and vertical bars between selectors:

```text
example.com=selector1|selector2
example.net=google|s1
```

An omitted domain receives a visible “No selectors configured” warning. DKIM selectors cannot be discovered reliably from DNS.

### TLS certificate endpoints

Use the same line-based mapping format. Each endpoint is `hostname:port`:

```text
example.com=mta-sts.example.com:443|mail.example.com:465
example.net=www.example.net:443
```

Direct TLS endpoints such as HTTPS 443, SMTP 465, and IMAP 993 are supported. SMTP STARTTLS on ports 25 and 587 is not currently probed.

## 1. Create the local repository

Download and extract the supplied archive, then run:

```bash
cd /path/to/mailposture
git init
git branch -M main
git add .
git status
git commit -m "Add generic MailPosture stack"
```

The repository contains only examples. You do not need to edit any file before pushing it.

## 2. Push it to GitHub

With GitHub CLI:

```bash
gh auth login
gh repo create mailposture --private --source=. --remote=origin --push
```

Alternatively, create an empty private `mailposture` repository on GitHub. Do not initialize it with extra files, then run:

```bash
git remote add origin git@github.com:YOUR_GITHUB_USERNAME/mailposture.git
git push -u origin main
```

## 3. Let GitHub build the image

The first push to `main` starts **Test and publish container image** under the repository's **Actions** tab. The workflow:

- runs the application tests;
- builds `linux/amd64` and `linux/arm64` images;
- publishes `ghcr.io/OWNER/REPOSITORY:latest`;
- also publishes an immutable `sha-...` tag;
- publishes version tags when a tag such as `v1.2.0` is pushed.

No registry password is required in the workflow. GitHub's temporary `GITHUB_TOKEN` publishes the image to the repository's GHCR package.

Wait for the workflow to finish successfully before the first Dockhand deployment.

### Public or private image

For the simplest homelab deployment, open the package from the repository's **Packages** section and make the container package public. The source repository can remain private.

To keep the image private, create a GitHub token that can read packages. In Dockhand, open **Settings → Registries** and add:

```text
Registry: ghcr.io
Username: your GitHub username
Password: a token with read:packages access
```

## 4. Create the Git stack in Dockhand

1. Add credentials for the private GitHub repository under **Settings → Git**.
2. Create a new Git-backed stack and choose the target Docker environment.
3. Select the repository and the `main` branch.
4. Set **Compose file path** to `docker-compose.yml`.
5. Set **Context directory** to the repository root (`.` or blank).
6. Leave **Build images on deploy** disabled; GitHub has already built the image.
7. Enable **Re-pull images** so Dockhand refreshes the `latest` tag.
8. Add the variables below in Dockhand's environment-variable panel.
9. Deploy.

### Required Dockhand variables

```dotenv
MAILPOSTURE_IMAGE=ghcr.io/your-github-username/mailposture:latest
OPENSEARCH_PASSWORD=your-real-opensearch-password
```

Mark `OPENSEARCH_PASSWORD` as a secret. It is required when the OpenSearch switch is enabled in MailPosture Settings; omit it when OpenSearch integration is disabled.

### Optional Dockhand variables

```dotenv
TZ=America/Los_Angeles
OPENSEARCH_URL=http://parsedmarc-opensearch:9200
OPENSEARCH_INDEX=dmarc_aggregate*
OPENSEARCH_USERNAME=admin
OPENSEARCH_VERIFY_TLS=false
MONITORING_NETWORK=monitoring
PROXY_NETWORK=proxy
MAILPOSTURE_DATA_VOLUME=mailposture_data
```

The Compose file provides the displayed defaults for optional values. Adding them explicitly to Dockhand makes the deployment settings easier to audit. Disable OpenSearch on the Settings screen to run only public DNS and endpoint checks; in that mode, an OpenSearch password is not required.

Use the lowercase owner and repository path shown on the GitHub package page for `MAILPOSTURE_IMAGE`.

## 5. Reverse proxy

The stack joins two external networks. Their defaults are `monitoring` and `proxy`, and both must already exist on the target Docker environment. Other users can set `MONITORING_NETWORK` and `PROXY_NETWORK` to their own network names without editing the repository.

Point the reverse proxy at:

```text
http://mailposture:8080
```

Keep authentication at the reverse proxy. MailPosture intentionally does not have a built-in login, and port 8080 is not published to the host.

## 6. Local testing

Copy the sample environment file and replace its example values locally:

```bash
cp .env.example .env
docker compose config
docker compose pull
docker compose up -d
```

Open MailPosture, choose **Settings**, add the monitored domains and mappings, then save. The settings are stored in the named volume rather than `.env`.

`.env` is excluded by `.gitignore`. It must never be committed.

For temporary direct browser access, add the following under the service in a local, uncommitted override file:

```yaml
ports:
  - "127.0.0.1:8080:8080"
```

## Updating the application

Repository changes are deployed with:

```bash
git add .
git commit -m "Update MailPosture"
git push
```

Wait for **Test and publish container image** to complete, then manually deploy or sync the stack in Dockhand. Dockhand will pull the refreshed `latest` image; it will not build locally.

### Optional automatic deployment after the image is ready

A normal GitHub push webhook can reach Dockhand before GHCR has finished building the new image. The included workflow can instead call Dockhand only after publishing succeeds.

After creating the Dockhand Git stack:

1. Configure a webhook secret in that stack and copy its unique webhook URL.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Add `DOCKHAND_WEBHOOK_URL` containing the full Dockhand stack webhook URL.
4. Add `DOCKHAND_WEBHOOK_SECRET` containing the matching secret.
5. Do not add a separate push webhook for this stack.

On later pushes, GitHub tests and publishes the image first, then signs a deployment request with HMAC-SHA256 and sends it to Dockhand. If either secret is absent, this step is skipped and manual deployment remains available.

## Existing parsedmarc path correction

The earlier monitoring stack starts parsedmarc with `/etc/parsedmarc.ini`, but mounts the configuration at `/etc/parsedmarc/config.ini`. The paths must match:

```yaml
command: ["-c", "/etc/parsedmarc/config.ini"]
volumes:
  - ${ROOT}/parsedmarc/config/parsedmarc.ini:/etc/parsedmarc/config.ini:ro
```

## Verification

```bash
npm test
```

MailPosture never writes to DNS, mailboxes, or OpenSearch. Its container uses a read-only root filesystem, a writable settings-only named volume, no Linux capabilities, and no host bind mounts.
