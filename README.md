# MailPosture with Dockhand

MailPosture is a generic, management-focused status page for DMARC aggregate and failure reports, SMTP TLS reports, DKIM, MTA-STS, TLS certificates, and BIMI. It contains no user-specific domain configuration. Operational settings are entered in the web interface and saved in persistent storage; Dockhand supplies deployment secrets and storage paths.

## Included files

```text
mailposture/
├── .github/workflows/       # Tests and publishes the image to GHCR
├── docker-compose.yml
├── compose.standalone.yml
├── Dockerfile
├── .env.example
├── server.js
├── public/
└── test/
```

Use `docker-compose.yml` when parsedmarc and OpenSearch already exist. Use `compose.standalone.yml` to deploy MailPosture, the official `ghcr.io/domainaware/parsedmarc` image, and OpenSearch together. They remain separate containers so each service can be upgraded, restarted, secured, and backed up independently.

## Interface

- **Dashboard** shows the organization-wide score, domain scores, open issues, aggregate DMARC trends, DMARC failure-report counts, and SMTP TLS results.
- **Domains** shows the detailed status, report center, attention queue, evidence, and control matrix for one domain at a time.
- **Settings** separates monitored domains, appearance, OpenSearch, and parsedmarc configuration into accessible tabs with keyboard navigation.
- **Help** explains setup, every check, and the terminology used by the application.

## Settings screen

After the first deployment, select the gear button in MailPosture. The Monitored domains, Appearance, OpenSearch, and parsedmarc tabs make room for each service's related options.

### Domains

Select the plus button to add a domain. Use the edit button beside a domain to change its name or manage its DKIM selectors and TLS certificate endpoints. Domain removal remains pending until **Save settings** is selected.

Add every domain that appears after the `@` in an organization-managed From address.

### DKIM selectors

Edit a domain, then add each active selector by its label, such as `selector1` or `google`. An omitted domain receives a visible “No selectors configured” warning. DKIM selectors cannot be discovered reliably from DNS.

### TLS certificate endpoints

Edit a domain, then add each endpoint as a host and port, such as `mta-sts.example.com` on port `443` or `mail.example.com` on port `465`.

Direct TLS endpoints such as HTTPS 443, SMTP 465, and IMAP 993 are supported. SMTP STARTTLS on ports 25 and 587 is not currently probed.

### Report source

Choose **Bundled services** with `compose.standalone.yml`, **External OpenSearch** when an existing parsedmarc/OpenSearch deployment supplies the data, or **Live checks only** to disable historical reporting. The OpenSearch password remains a Dockhand secret and is never returned to the browser.

### Report mailbox

One mailbox is normally sufficient for every monitored domain. Point each domain's DMARC `rua` and TLS-RPT `rua` address—or aliases for those addresses—to the same account. parsedmarc watches the configured incoming folder and sorts messages below the configured archive folder:

```text
Archive/
├── Aggregate
├── Failure
├── Invalid
├── SMTP-TLS
└── Unsaved
```

Saving Settings writes `/data/parsedmarc/config.ini`. The standalone Compose file mounts that generated file at parsedmarc's active `/etc/parsedmarc/config.ini` path and reloads parsedmarc automatically within 10 seconds when it changes. An external parsedmarc deployment must mount the same generated directory—or copy the file to its configured path—and must be restarted by its own service manager.

`Archive/SMTP-TLS` contains the original TLS-RPT messages after parsedmarc processes them. MailPosture does not read or parse that folder. It reads the normalized documents that parsedmarc writes to the configured `smtp_tls*` OpenSearch index, which prevents duplicate processing and mailbox conflicts.

The parsedmarc tab manages the general, mailbox, IMAP, and OpenSearch options used by the bundled IMAP-to-OpenSearch pipeline. Less common outputs and collectors, including Kafka, S3, Splunk, Gmail API, and Microsoft Graph, remain advanced file-based configuration. MailPosture does not parse, move, or delete report messages itself; parsedmarc performs the configured mailbox actions.

Failure reports can contain message headers or content. MailPosture shows counts but intentionally does not display those samples.

### OpenSearch snapshots

The standalone stack mounts `${ROOT}/mailposture/opensearch/snapshots` by default and MailPosture registers it as the `mailposture` file-system repository. Set `OPENSEARCH_SNAPSHOT_PATH` to reuse an existing absolute host path instead. Saving an enabled snapshot schedule creates or updates OpenSearch's native `mailposture` snapshot policy using the configured creation cron, cleanup cron, time zone, age, and count limits.

The snapshot directory is on the same host by default. Copy it to separate storage to protect against host or disk failure.

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
4. Set **Compose file path** to `compose.standalone.yml` for a complete deployment, or `docker-compose.yml` when using an existing OpenSearch service.
5. Set **Context directory** to the repository root (`.` or blank).
6. Leave **Build images on deploy** disabled; GitHub has already built the image.
7. Enable **Re-pull images** so Dockhand refreshes the `latest` tag.
8. Add the variables below in Dockhand's environment-variable panel.
9. Deploy.

### Required Dockhand variables

```dotenv
MAILPOSTURE_IMAGE=ghcr.io/your-github-username/mailposture:latest
ROOT=/srv/docker-data
OPENSEARCH_INITIAL_ADMIN_PASSWORD=your-strong-opensearch-password
```

Mark the OpenSearch password as a secret. For the lightweight Compose file, provide the same value as `OPENSEARCH_PASSWORD` instead of `OPENSEARCH_INITIAL_ADMIN_PASSWORD`.

### Optional Dockhand variables

```dotenv
TZ=America/Los_Angeles
OPENSEARCH_URL=http://parsedmarc-opensearch:9200
OPENSEARCH_INDEX=dmarc_aggregate*
OPENSEARCH_FAILURE_INDEX=dmarc_failure*,dmarc_forensic*
OPENSEARCH_SMTP_TLS_INDEX=smtp_tls*
OPENSEARCH_USERNAME=admin
OPENSEARCH_VERIFY_TLS=false
MONITORING_NETWORK=monitoring
PROXY_NETWORK=proxy
MAILPOSTURE_DATA_VOLUME=mailposture_data
OPENSEARCH_VERSION=2
PARSEDMARC_VERSION=latest
OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g
MAILPOSTURE_SETTINGS_PATH=/srv/docker-data/mailposture
OPENSEARCH_DATA_PATH=/srv/docker-data/parsedmarc/opensearch/data
OPENSEARCH_SNAPSHOT_PATH=/srv/docker-data/parsedmarc/opensearch/snapshots
```

The Compose files provide defaults for optional values. The three `*_PATH` variables are migration overrides: set them to absolute host paths to reuse MailPosture settings, OpenSearch data, or an existing snapshot repository, and omit them for the new default folders. Do not run snapshot jobs from two OpenSearch clusters against the same repository. The Settings screen can override the OpenSearch URL, username, index patterns, and certificate verification behavior. The password remains an environment secret.

Use the lowercase owner and repository path shown on the GitHub package page for `MAILPOSTURE_IMAGE`.

## 5. Reverse proxy

The lightweight stack joins the existing external `monitoring` and `proxy` networks. The standalone stack creates its own private `mailposture-backend` network and joins only the existing external `proxy` network. Set `MONITORING_NETWORK` or `PROXY_NETWORK` to use different existing network names without editing the repository.

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

Open MailPosture, select the Settings button, add the monitored domains and their selectors and endpoints, then save. With the standalone stack, also enter the report mailbox and enable snapshots. parsedmarc starts after the first valid mailbox configuration is saved and reloads automatically after later changes. Appearance preference is stored in the browser because it is specific to each device.

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

## Standalone persistent folders

Create these folders before the first standalone deployment and grant the container users access appropriate to your Docker host:

```text
${ROOT}/mailposture/
├── settings/
│   ├── settings.json
│   ├── secrets.json
│   └── parsedmarc/config.ini
└── opensearch/
    ├── data/
    └── snapshots/
```

Do not place this mutable data inside Dockhand's Git checkout. Do not commit `settings.json`, `secrets.json`, `config.ini`, OpenSearch data, or snapshots.

To keep the data from the stack shown in this guide without copying it, set these Dockhand variables to the actual absolute paths represented by your current `${ROOT}` value:

```dotenv
MAILPOSTURE_SETTINGS_PATH=/your/current/root/mailposture
OPENSEARCH_DATA_PATH=/your/current/root/parsedmarc/opensearch/data
OPENSEARCH_SNAPSHOT_PATH=/your/current/root/parsedmarc/opensearch/snapshots
```

Stop the old parsedmarc and OpenSearch services before starting the standalone stack against those paths. A data directory or snapshot repository must never be opened concurrently by two OpenSearch containers.

## Verification

```bash
npm test
```

MailPosture never writes to DNS or mailboxes. In standalone mode it writes its own settings, secrets, and generated parsedmarc configuration, and it manages the OpenSearch snapshot repository and policy. Its root filesystem remains read-only, `/data` is the only writable application mount, and the container has no Linux capabilities or Docker socket access.
