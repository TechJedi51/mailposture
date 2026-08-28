# MailPosture with Dockhand

MailPosture is a generic, read-only status page for DMARC, parsedmarc aggregate results, MTA-STS, TLS-RPT, BIMI, TLS certificates, and DKIM. It contains no user-specific domain configuration. Dockhand supplies every deployment value through environment variables.

## Included files

```text
mailposture/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── server.js
├── public/
└── test/
```

No configuration file or host bind mount is required.

## Environment-variable format

### Domains

Use a comma-separated list:

```dotenv
MONITORED_DOMAINS=example.com,example.net
```

### DKIM selectors

Use semicolons between domains and vertical bars between selectors:

```dotenv
DKIM_SELECTORS=example.com=selector1|selector2;example.net=google|s1
```

An omitted domain receives a visible “No selectors configured” warning. DKIM selectors cannot be discovered reliably from DNS.

### TLS certificate endpoints

Use the same domain mapping format. Each endpoint is `hostname:port`:

```dotenv
TLS_ENDPOINTS=example.com=mta-sts.example.com:443|mail.example.com:465;example.net=www.example.net:443
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

## 3. Create the Git stack in Dockhand

1. Add credentials for the private GitHub repository under **Settings → Git**.
2. Create a new Git-backed stack and choose the target Docker environment.
3. Select the repository and the `main` branch.
4. Set **Compose file path** to `docker-compose.yml`.
5. Set **Context directory** to the repository root (`.` or blank).
6. Enable **Build images on deploy**.
7. Leave **Disable build cache** off for normal deployments.
8. Add the variables below in Dockhand's environment-variable panel.
9. Deploy.

### Required Dockhand variables

```dotenv
MONITORED_DOMAINS=example.com,example.net
DKIM_SELECTORS=example.com=selector1|selector2;example.net=google|s1
TLS_ENDPOINTS=example.com=mta-sts.example.com:443|mail.example.com:465;example.net=www.example.net:443
OPENSEARCH_PASSWORD=your-real-opensearch-password
```

Mark `OPENSEARCH_PASSWORD` as a secret. It is required when `OPENSEARCH_ENABLED=true`; omit it when OpenSearch integration is disabled.

### Optional Dockhand variables

```dotenv
TZ=America/Los_Angeles
REPORT_DAYS=7
REFRESH_MINUTES=15
REQUEST_TIMEOUT_MS=8000
OPENSEARCH_URL=http://parsedmarc-opensearch:9200
OPENSEARCH_INDEX=dmarc_aggregate*
OPENSEARCH_USERNAME=admin
OPENSEARCH_VERIFY_TLS=false
OPENSEARCH_ENABLED=true
MONITORING_NETWORK=monitoring
PROXY_NETWORK=proxy
```

The Compose file provides the displayed defaults for optional values. Adding them explicitly to Dockhand makes the deployment settings easier to audit. Set `OPENSEARCH_ENABLED=false` to run only the public DNS and endpoint checks; in that mode, an OpenSearch password is not required.

## 4. Reverse proxy

The stack joins two external networks. Their defaults are `monitoring` and `proxy`, and both must already exist on the target Docker environment. Other users can set `MONITORING_NETWORK` and `PROXY_NETWORK` to their own network names without editing the repository.

Point the reverse proxy at:

```text
http://mailposture:8080
```

Keep authentication at the reverse proxy. MailPosture intentionally does not have a built-in login, and port 8080 is not published to the host.

## 5. Local testing

Copy the sample environment file and replace its example values locally:

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
```

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

Then run a Git sync in Dockhand or configure a schedule or webhook. Keep **Build images on deploy** enabled.

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

MailPosture never writes to DNS, mailboxes, or OpenSearch. Its container uses a read-only filesystem, no Linux capabilities, and no host mounts.
