<script setup lang="ts">
/**
 * Integration guide rendered inside the SPA. Content is static and mirrors the
 * implemented server API (apps/server/src) — update both together. Code samples
 * are interpolated with the current origin so they are copy-paste ready.
 */
import CodeBlock from '../components/ui/CodeBlock.vue'

const origin = window.location.origin
const api = (path: string): string => `${origin}/api/v1${path}`

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'auth', label: 'Authentication' },
  { id: 'monitors', label: 'Creating monitors' },
  { id: 'push', label: 'Push heartbeats' },
  { id: 'reading', label: 'Reading results' },
  { id: 'realtime', label: 'Realtime (SSE)' },
  { id: 'metrics', label: 'Prometheus' },
  { id: 'status', label: 'Status pages' },
  { id: 'automation', label: 'Automation' },
  { id: 'errors', label: 'Errors & limits' },
] as const

// ---- Authentication --------------------------------------------------------

const loginSnippet = `curl -s -X POST ${api('/auth/login')} \\
  -H 'Content-Type: application/json' \\
  -c cookies.txt \\
  -d '{"email": "dev@example.com", "password": "********"}'

# 200 {"user":{"id":1,"email":"dev@example.com","role":"admin"},
#      "csrfToken":"e0d1c2…"}
# The session cookie (uptime_session) is httpOnly — cookies.txt keeps it.`

const twofaSnippet = `# {"error":"2fa_required"} — resend with the second factor:
curl -s -X POST ${api('/auth/login')} \\
  -H 'Content-Type: application/json' \\
  -c cookies.txt \\
  -d '{"email": "dev@example.com", "password": "********", "otp": "123456"}'

# Locked out? "recoveryCode" is accepted instead of "otp".
# 5 failed attempts per IP per 15 minutes → 429 {"error":"too_many_attempts",
# "retryAfterMs":…}.`

const apiKeySnippet = `curl -s -X POST ${api('/auth/api-keys')} \\
  -H 'Content-Type: application/json' \\
  -b cookies.txt \\
  -H 'x-csrf-token: <csrfToken from login>' \\
  -d '{"name": "ci", "scopes": ["write"], "expiresAt": "2027-01-01T00:00:00Z"}'

# 201 {"key":"uk_x7Kd…"}  ← shown exactly once — store it now.`

const bearerSnippet = `curl -s ${api('/monitors')} \\
  -H 'Authorization: Bearer uk_x7Kd…'`

// ---- Creating monitors -----------------------------------------------------

const createHttpSnippet = `curl -s -X POST ${api('/monitors')} \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer uk_x7Kd…' \\
  -d '{
    "type": "http",
    "name": "Checkout API",
    "intervalS": 60,
    "retries": 3,
    "retryIntervalS": 30,
    "tags": ["prod", "api"],
    "channelIds": [1],
    "config": {
      "url": "https://api.example.com/health",
      "method": "GET",
      "timeoutMs": 5000,
      "acceptedStatus": [200, 299],
      "keyword": { "value": "\\"status\\":\\"ok\\"" },
      "maxResponseMs": 1500,
      "certExpiryDays": 14
    }
  }'

# 201 {"monitor":{…}} — config is validated server-side per type;
# an invalid config answers 400 {"error": "…"} without creating anything.`

const createPushSnippet = `curl -s -X POST ${api('/monitors')} \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer uk_x7Kd…' \\
  -d '{
    "type": "push",
    "name": "Nightly ETL",
    "intervalS": 3600,
    "retries": 1,
    "config": { "graceSeconds": 900 }
  }'

# 201 {"monitor":{…, "pushUrl":"/api/v1/push/9f2c…"}} ← the token is the
# secret; it is generated at creation and only leaves the server here.`

const createGroupSnippet = `curl -s -X POST ${api('/monitors')} \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer uk_x7Kd…' \\
  -d '{
    "type": "group",
    "name": "EU edge",
    "config": { "memberIds": [3, 4, 5], "strategy": "percentage", "percentage": 50 }
  }'

# Strategies: "any-up", "all-up", "percentage" (requires "percentage").
# While the group is down its own notifications are sent, but member
# incidents are suppressed — wire alerting to the group, not the members.`

const configTable: { type: string; config: string }[] = [
  { type: 'http', config: 'url (required), method (default GET), headers, body, timeoutMs (default 10000), acceptedStatus ([200, 299] or "any"), keyword {value, inverse}, maxResponseMs, certExpiryDays, jsonPaths' },
  { type: 'push', config: 'graceSeconds (default 60), cron (5 or 6 fields, [0-9*/,-]), expectsBody' },
  { type: 'tcp', config: 'host, port, timeoutMs, payload?, expectResponse?' },
  { type: 'dns', config: 'host, resolver?, recordType (A/AAAA/CNAME/MX/TXT/NS/SRV), expectedValue?, timeoutMs' },
  { type: 'icmp', config: 'host, timeoutMs, packetCount (1-10) — container needs NET_RAW' },
  { type: 'postgres / mysql / mssql / mongodb / redis', config: 'connectionString, timeoutMs, query (default SELECT 1 / PING)' },
  { type: 'docker', config: 'hostUri (unix:// or tcp://), containerNameOrId, expectedState (default "running"), tlsCaPem/tlsCertPem/tlsKeyPem' },
  { type: 'group', config: 'memberIds (≥1), strategy (any-up | all-up | percentage), percentage (required for percentage)' },
]

// ---- Push heartbeats -------------------------------------------------------

const pushLifecycleSnippet = `BASE=${api('/push/<token>')}

# 1. Job starts (optional — marks a "pending" beat for duration tracking)
curl -fsS "$BASE/start"

# 2. Job succeeded → up
curl -fsS "$BASE"            # GET or POST, both accepted

# 3. Job failed → down + the captured log excerpt on the incident
curl -fsS -G "$BASE/fail" --data-urlencode "body@job-error.log"

# Everything answers {"ok":true}; an unknown token answers 404.`

const pushShellSnippet = `#!/bin/sh
# /etc/cron.hourly/report-sync — silence longer than intervalS + graceSeconds
# marks the job down; a late run recovers it automatically.
LOG=$(mktemp)
if /usr/local/bin/sync.sh >"$LOG" 2>&1; then
  curl -fsS "${api('/push/<token>')}"
else
  curl -fsS -G "${api('/push/<token>')}/fail" --data-urlencode "body@$LOG"
fi
rm -f "$LOG"`

const pushActionsSnippet = `deploy:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: ./deploy.sh
    - name: Report to uptime monitoring
      if: always()
      run: |
        BASE="${api('/push/<token>')}"
        if [ "\${{ job.status }}" = "success" ]; then
          curl -fsS "$BASE"
        else
          curl -fsS "$BASE/fail?body=deploy+failed"
        fi`

const pushNodeSnippet = `const base = '${api('/push/<token>')}'

try {
  await runEtl()
  await fetch(base, { method: 'POST' })                       // up
} catch (error) {
  const body = encodeURIComponent(String(error).slice(0, 1024))
  await fetch(\`\${base}/fail?body=\${body}\`)                  // down
}`

// ---- Reading results -------------------------------------------------------

const uptimeSnippet = `curl -s -H 'Authorization: Bearer uk_x7Kd…' \\
  '${api('/monitors/1/uptime')}?hours=7'

# {"total":10080,"up":10064,"down":16,"maintenance":0,"uptimePct":99.84}
# hours=24 is hours; 7/30/365 are day-based ranges.`

const heartbeatsSnippet = `curl -s -H 'Authorization: Bearer uk_x7Kd…' \\
  '${api('/monitors/1/heartbeats')}?limit=20' | jq '.heartbeats[0]'

# {"id":123,"monitorId":1,"status":"up","latencyMs":87,
#  "responseSnippet":"2xx in 87 ms","time":"2026-10-11T09:30:00.000Z"}
# limit is clamped to 1–1000 (default 100), newest first.`

const incidentsSnippet = `curl -s -H 'Authorization: Bearer uk_x7Kd…' \\
  '${api('/incidents')}?active=1' | jq '.incidents[0]'

# {"id":7,"monitorId":1,"monitorName":"Checkout API","title":"Checkout API is down",
#  "body":"HTTP 503 after 3 attempts","openedAt":"…","resolvedAt":null}`

// ---- Realtime --------------------------------------------------------------

const sseSnippet = `const es = new EventSource('${api('/events')}')

es.onmessage = (msg) => {
  const event = JSON.parse(msg.data)
  switch (event.type) {
    case 'heartbeat':
      // { monitorId, status: 'up'|'down'|'pending'|'maintenance',
      //   latencyMs, time } — ISO timestamp
      break
    case 'incident':
      // { monitorId, incidentId, state: 'open'|'resolved', title, time }
      break
    case 'maintenance':
      // { monitorId, under: boolean, time }
      break
  }
}

// Reconnects natively on drop; the server sends ": ping" comments every 25 s.`

// ---- Status pages ----------------------------------------------------------

const statusJsonSnippet = `curl -s ${api('/status/acme')} | jq '{overall, groups: [.groups[].components[] | {id, label, status}] }'

# {
#   "overall": "partial_outage",
#   "groups": [{ "id": "api", "label": "API", "status": "major_outage" }, …]
# }
#
# Full payload: slug, title, logo, theme, footerText, overall
# (operational | degraded | partial_outage | major_outage | maintenance |
#  unknown), groups[].components[] ({id, label, description, status,
#   showUptime, showChart, monitors[], uptimePct, daily[], series?}),
# incidents[] (with updates[]), maintenance {active, upcoming},
# passwordRequired.`

const badgeHtmlSnippet = `<img
  src="${origin}/status/acme/badge.svg"
  alt="acme status"
  width="196"
  height="20">`

const badgeMarkdownSnippet = `[![status](${origin}/status/acme/badge.svg)](${origin}/status/acme)

<!-- A single component instead of the overall badge: -->
![api](${origin}/status/acme/badge.svg?component=api)`

const statusFeedsSnippet = `# Incident feeds (RSS 2.0 / Atom), machine-readable and cache-friendly:
curl -s ${origin}/status/acme/rss.xml | head -n 4
curl -s ${origin}/status/acme/atom.xml | head -n 4

# Password-protected pages: JSON answers 401 {"error":"password_required"},
# feeds and badges answer 404 until the unlock cookie is present.
curl -s -X POST ${api('/status/acme/unlock')} \\
  -H 'Content-Type: application/json' \\
  -c cookies.txt \\
  -d '{"password": "********"}'   # 204 when the page has no password`

const scrapeSnippet = `scrape_configs:
  - job_name: uptime-monitoring
    metrics_path: /metrics
    static_configs:
      - targets: ['${origin.replace(/^https?:\/\//, '')}']`

// ---- Automation ------------------------------------------------------------

const openapiSnippet = `# One http monitor per GET endpoint of your service (run where openapi.json lives):
pnpm openapi-bootstrap \\
  --server ${origin} \\
  --file openapi.json \\
  --api-key "$UPTIME_ADMIN_API_KEY" \\
  --header 'Authorization: Bearer <token your API expects>' \\
  --dry-run

# Creates GET probes with acceptedStatus [200, 299], tagged openapi:<info.title>.
# Parameterised paths (/users/{id}) are skipped; authed endpoints need
# --include-authed plus a --header that authenticates the probe.`

const lifecycleSnippet = `# Snapshot every monitor as JSON (admin key required):
curl -s -X POST -H 'Authorization: Bearer uk_x7Kd…' \\
  ${api('/config/export')} -o config.json

# Re-create monitors from a snapshot (existing ids stay instance-local):
curl -s -X POST -H 'Authorization: Bearer uk_x7Kd…' \\
  -H 'Content-Type: application/json' \\
  --data @config.json ${api('/config/import')}

# SQLite snapshot into <DATA_DIR>/backups, then prune heartbeats older than 180 days:
curl -s -X POST -H 'Authorization: Bearer uk_x7Kd…' ${api('/backup')}
curl -s -X POST -H 'Authorization: Bearer uk_x7Kd…' \\
  -H 'Content-Type: application/json' \\
  -d '{"days": 180}' ${api('/retention/run')}`

// ---- Errors ----------------------------------------------------------------

const errorRows: { code: string; body: string; when: string }[] = [
  { code: '400', body: '{"error":"…"}', when: 'Invalid JSON body, unknown monitor type, failed config validation' },
  { code: '401', body: '{"error":"invalid_api_key"}', when: 'Bearer key unknown or expired (also: invalid_credentials, 2fa_required, password_required)' },
  { code: '403', body: '{"error":"insufficient_scope"}', when: 'Key scope or user role is below the endpoint requirement' },
  { code: '404', body: '{"error":"unknown push token"}', when: 'Push token, monitor id, or status page slug does not exist' },
  { code: '409', body: '{"error":"setup_complete"}', when: 'First-run setup when a user already exists (also: totp_already_enabled)' },
  { code: '429', body: '{"error":"too_many_attempts","retryAfterMs":…}', when: 'More than 5 failed logins per IP within 15 minutes' },
  { code: '503', body: '{"status":"fail","db":"fail"}', when: '/healthz only — the process is up but the database is not' },
]

const limitsRows: { limit: string; value: string }[] = [
  { limit: 'intervalS', value: '≥ 20 s (default 60)' },
  { limit: 'retries', value: '1–100 (default 1); retryIntervalS default 60 s' },
  { limit: 'HTTP check timeout', value: 'timeoutMs, default 10000 ms' },
  { limit: 'Heartbeat list', value: 'limit clamped to 1–1000 (default 100)' },
  { limit: 'Captured bodies', value: 'push /fail?body= and response snippets truncated to 1 KiB' },
  { limit: 'Request body', value: '1 MB JSON limit on all endpoints' },
  { limit: 'Prometheus response buckets', value: '10, 50, 100, 250, 500, 1000, 2500, 5000, 10000 ms' },
]
</script>

<template>
  <div class="view">
    <header class="intro">
      <h1>Integration guide</h1>
      <p>
        Everything this instance exposes outside the UI: the REST API, push
        heartbeats for jobs that cannot be probed from the outside, realtime
        events, Prometheus metrics, and public status pages. Examples are
        rendered against <code>{{ origin }}</code> so you can copy-paste them as-is —
        every endpoint below is verified against this server's implementation.
      </p>
    </header>

    <nav class="toc" aria-label="Sections">
      <a v-for="section in SECTIONS" :key="section.id" :href="`#${section.id}`">
        {{ section.label }}
      </a>
    </nav>

    <!-- Overview -->
    <section id="overview" class="doc-section">
      <h2>Overview</h2>
      <p>
        All endpoints live under <code>/api/v1</code> and speak JSON. The static
        UI is served from the same origin, so no CORS setup is needed for
        browser integrations. Three transports carry the same data:
      </p>
      <ul>
        <li>
          <strong>Pull</strong> — REST (<code>/api/v1/monitors</code>,
          <code>/heartbeats</code>, <code>/uptime</code>, <code>/incidents</code>) for
          scripts and dashboards.
        </li>
        <li>
          <strong>Push</strong> — the check engine probes your services, and
          <code>/api/v1/push/&lt;token&gt;</code> lets jobs that only run inside your
          network report their own outcome (Healthchecks-style).
        </li>
        <li>
          <strong>Stream</strong> — Server-Sent Events at
          <code>/api/v1/events</code> and Prometheus exposition at
          <code>/metrics</code>.
        </li>
      </ul>
      <p>
        Roles: <em>viewer</em> reads everything, <em>editor</em> manages
        monitors, <em>admin</em> manages users, keys, channels, and settings.
        The unauthenticated surface is deliberately tiny:
        <code>/healthz</code>, <code>/metrics</code> (restrictable), the push
        receiver, published status pages, and the two password-recovery
        endpoints (rate-limited, enumeration-safe).
      </p>
    </section>

    <!-- Authentication -->
    <section id="auth" class="doc-section">
      <h2>Authentication</h2>

      <h3>Sessions (browsers)</h3>
      <p>
        <code>POST /api/v1/auth/login</code> sets an httpOnly session cookie
        (<code>uptime_session</code>, SameSite=Lax, 7 days) and returns the
        user plus a CSRF token. <strong>Every mutating request made with the
        cookie must repeat that token in the <code>x-csrf-token</code>
        header</strong>; GETs are exempt.
      </p>
      <CodeBlock label="Login" :code="loginSnippet" />
      <p>
        With TOTP enabled the first attempt answers
        <code>401 {"error":"2fa_required"}</code>; repeat it with
        <code>otp</code> (or a <code>recoveryCode</code>):
      </p>
      <CodeBlock label="Two-factor login" :code="twofaSnippet" />

      <h3>API keys (scripts &amp; CI)</h3>
      <p>
        API keys authenticate <code>Authorization: Bearer</code> requests and
        skip CSRF entirely. Create them in <em>Settings → API keys</em> or via
        the API as admin — the <code>uk_…</code> secret is shown once.
        Scopes map onto roles: <code>read</code> ≥ viewer,
        <code>write</code> ≥ editor, <code>admin</code> ≥ admin. Optional
        <code>expiresAt</code> takes an ISO timestamp or unix milliseconds.
      </p>
      <CodeBlock label="Create a key (admin session)" :code="apiKeySnippet" />
      <p>Use it on every route that requires a role:</p>
      <CodeBlock label="Bearer request" :code="bearerSnippet" />
      <p>
        First run only: <code>GET /api/v1/auth/state</code> reports
        <code>{"setupRequired":true}</code> and
        <code>POST /api/v1/auth/setup</code> creates the initial admin
        (auto-login, same response shape as login).
      </p>
    </section>

    <!-- Creating monitors -->
    <section id="monitors" class="doc-section">
      <h2>Creating monitors</h2>
      <p>
        <code>POST /api/v1/monitors</code> (editor+) takes
        <code>type</code>, <code>name</code>, scheduling fields
        (<code>intervalS</code>, <code>retries</code>,
        <code>retryIntervalS</code>), a type-specific <code>config</code>
        object, and optional <code>tags</code> (names, created on the fly),
        <code>tagIds</code>, and <code>channelIds</code> for notification
        routing. <code>PATCH /api/v1/monitors/:id</code> updates a subset;
        <code>DELETE</code> removes the monitor and its heartbeats.
      </p>
      <CodeBlock label="HTTP monitor" :code="createHttpSnippet" />
      <p>
        An HTTP check is <em>up</em> when the status is inside
        <code>acceptedStatus</code>, the <code>keyword</code> assertion holds
        (with <code>inverse: true</code> the body must <em>not</em> contain
        it), latency ≤ <code>maxResponseMs</code>, and the TLS certificate is
        valid for ≥ <code>certExpiryDays</code> days.
      </p>
      <CodeBlock label="Push monitor" :code="createPushSnippet" />
      <p>
        <code>http</code> and <code>docker</code> monitors are actively
        scheduled; the other engine types (tcp, dns, icmp, databases) validate
        and store, and are checked by their engines as they come online.
        <code>group</code> monitors derive their status from members:
      </p>
      <CodeBlock label="Group monitor" :code="createGroupSnippet" />

      <h3>Config reference</h3>
      <table class="doc-table">
        <thead>
          <tr><th>Type</th><th>config fields</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in configTable" :key="row.type">
            <td><code>{{ row.type }}</code></td>
            <td>{{ row.config }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Push -->
    <section id="push" class="doc-section">
      <h2>Push heartbeats</h2>
      <p>
        Push monitors flip the model: instead of being probed, the job reports
        itself. The token in <code>monitor.pushUrl</code> <em>is</em> the
        secret — these endpoints need no auth. Silence is the failure signal:
        a sweep every 30 s marks the monitor down once
        <code>intervalS + graceSeconds</code> (or the next
        <code>cron</code> run + grace) has passed since the last beat, and a
        successful ping closes the incident again. A push monitor that has
        <em>never</em> sent a beat stays <code>pending</code> and opens no
        incident.
      </p>
      <CodeBlock label="Lifecycle" :code="pushLifecycleSnippet" />
      <p>
        <code>/start</code> records a <code>pending</code> beat so the UI can
        show run duration. <code>/fail</code> stores its
        <code>body</code> query parameter (first 1 KiB) as the heartbeat
        snippet — pipe the tail of your log into it.
      </p>
      <CodeBlock label="Cron job (shell)" :code="pushShellSnippet" />
      <CodeBlock label="GitHub Actions" :code="pushActionsSnippet" />
      <CodeBlock label="Node" :code="pushNodeSnippet" />
    </section>

    <!-- Reading -->
    <section id="reading" class="doc-section">
      <h2>Reading results</h2>
      <p>
        Heartbeats are the raw check log; uptime is computed from them; incidents
        are state transitions. All three take a monitor id and answer with the
        wrapped shape shown below.
      </p>
      <CodeBlock label="Uptime" :code="uptimeSnippet" />
      <CodeBlock label="Heartbeats" :code="heartbeatsSnippet" />
      <CodeBlock label="Incidents" :code="incidentsSnippet" />
      <p>
        <code>GET /api/v1/incidents?active=1</code> (or <code>0</code>)
        filters to open/closed. <code>status</code> values are
        <code>up</code>, <code>down</code>, <code>pending</code>,
        <code>maintenance</code>.
      </p>
    </section>

    <!-- Realtime -->
    <section id="realtime" class="doc-section">
      <h2>Realtime (SSE)</h2>
      <p>
        <code>GET /api/v1/events</code> streams every heartbeat, incident, and
        maintenance transition as JSON Server-Sent Events. It authenticates
        with the session cookie — <code>EventSource</code> cannot set an
        <code>Authorization</code> header, so for server-to-server use either
        relay through a small proxy with a key, or poll
        <code>/incidents</code> instead.
      </p>
      <CodeBlock label="EventSource" :code="sseSnippet" />
    </section>

    <!-- Metrics -->
    <section id="metrics" class="doc-section">
      <h2>Prometheus</h2>
      <p>
        <code>GET /metrics</code> is open by default and restricted with the
        <code>METRICS_ALLOWLIST</code> env var (comma-separated IPv4/CIDR,
        e.g. <code>10.0.0.0/8,192.168.1.4</code>). Per-monitor series are
        labeled with <code>monitor_id</code> and <code>monitor_name</code>.
      </p>
      <table class="doc-table">
        <thead>
          <tr><th>Metric</th><th>Type</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>monitor_up</code></td><td>gauge</td><td>1 if up, 0 if down</td></tr>
          <tr><td><code>monitor_response_ms</code></td><td>histogram</td><td>Check latency in ms (buckets 10 ms – 10 s)</td></tr>
          <tr><td><code>monitor_cert_expiry_days</code></td><td>gauge</td><td>Days until the TLS certificate expires (absent when not applicable)</td></tr>
          <tr><td><code>monitor_maintenance</code></td><td>gauge</td><td>1 while inside a maintenance window</td></tr>
          <tr><td><code>tag_monitors_up</code> / <code>tag_monitors_down</code></td><td>gauge</td><td>Per-tag up/down counts, labeled <code>tag</code></td></tr>
          <tr><td><code>process_*</code>, <code>nodejs_*</code></td><td>default</td><td>Standard prom-client collectors</td></tr>
        </tbody>
      </table>
      <CodeBlock label="scrape config" :code="scrapeSnippet" />
      <p>
        Liveness for containers and load balancers:
        <code>GET /healthz</code> (no auth) answers
        <code>{"status":"ok","db":"ok"}</code> or
        <code>503</code> when the database ping fails.
      </p>
    </section>

    <!-- Status pages -->
    <section id="status" class="doc-section">
      <h2>Status pages</h2>
      <p>
        Published pages are public: the HTML page at
        <code>/status/&lt;slug&gt;</code> (with OpenGraph meta injected
        server-side for crawlers), a JSON API, incident feeds, and a
        Shields-style badge for READMEs and dashboards.
      </p>
      <CodeBlock label="Public JSON" :code="statusJsonSnippet" />
      <p>
        <code>overall</code> is the worst severity across components. Component
        ids come from the page structure configured in Settings; use one as
        <code>?component=</code> to badge a single component. Feeds:
        <code>/status/&lt;slug&gt;/rss.xml</code> and
        <code>/atom.xml</code> list incident updates.
      </p>
      <CodeBlock label="HTML embed" :code="badgeHtmlSnippet" />
      <CodeBlock label="Markdown embed" :code="badgeMarkdownSnippet" />
      <CodeBlock label="Feeds & password pages" :code="statusFeedsSnippet" />
      <h3>Public status overview</h3>
      <p>
        For a lightweight alternative, flag individual monitors as public in
        the monitor form. The unauthenticated page at <code>/status</code> and
        <code>GET /api/v1/public/status</code> then list each public service by
        name with its heartbeat status, latency, trailing-24-hour uptime and
        active maintenance windows. Target URLs and check configuration are
        never included. Full status pages stay independent of the flag.
      </p>
    </section>

    <!-- Automation -->
    <section id="automation" class="doc-section">
      <h2>Automation</h2>
      <p>
        Bootstrap monitoring for a whole service from its OpenAPI document —
        the script ships with the repo and uses the admin API:
      </p>
      <CodeBlock label="openapi-bootstrap" :code="openapiSnippet" />
      <p>
        For migrations and backups the lifecycle endpoints (admin) snapshot and
        restore configuration without touching the database directly:
      </p>
      <CodeBlock label="Export / import / backup" :code="lifecycleSnippet" />
    </section>

    <!-- Errors -->
    <section id="errors" class="doc-section">
      <h2>Errors &amp; limits</h2>
      <p>
        Errors are JSON with an <code>error</code> code; validation failures
        explain themselves in the message. The ones worth handling explicitly:
      </p>
      <table class="doc-table">
        <thead>
          <tr><th>Status</th><th>Body</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in errorRows" :key="row.code">
            <td class="tabular">{{ row.code }}</td>
            <td><code>{{ row.body }}</code></td>
            <td>{{ row.when }}</td>
          </tr>
        </tbody>
      </table>

      <h3>Limits</h3>
      <table class="doc-table">
        <tbody>
          <tr v-for="row in limitsRows" :key="row.limit">
            <td>{{ row.limit }}</td>
            <td>{{ row.value }}</td>
          </tr>
        </tbody>
      </table>

      <p class="note">
        Note: the spec lists <code>POST /monitors/:id/test</code> (dry-run a
        check on demand) — it is specified, not implemented yet. Don't code
        against it.
      </p>
    </section>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 860px;
}

.intro h1 {
  margin: 0 0 var(--space-2);
  font-size: 20px;
  font-weight: 600;
}

.intro p {
  margin: 0;
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.6;
}

.intro code,
.doc-section code {
  font-family: var(--font-mono);
  font-size: 12px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
}

.toc {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.toc a {
  padding: var(--space-1) var(--space-3);
  background-color: transparent;
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-size: 12.5px;
  text-decoration: none;
}

.toc a:hover {
  color: var(--ink);
  border-color: var(--ink-3);
  background-color: transparent;
}

.doc-section {
  scroll-margin-top: calc(var(--topbar-height) + var(--space-4));
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.doc-section h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.doc-section h3 {
  margin: var(--space-2) 0 0;
  font-size: 13.5px;
  font-weight: 600;
}

.doc-section p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
}

.doc-section ul {
  margin: 0;
  padding-left: var(--space-5);
  font-size: 13.5px;
  line-height: 1.65;
}

.doc-section li + li {
  margin-top: var(--space-1);
}

.doc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.doc-table th,
.doc-table td {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.doc-table th {
  background-color: var(--surface-2);
  font-weight: 600;
}

.doc-table td:first-child {
  white-space: nowrap;
}

.tabular {
  font-variant-numeric: tabular-nums;
}

.note {
  color: var(--muted);
  font-size: 12.5px;
}

@media (max-width: 720px) {
  .doc-table td:first-child {
    white-space: normal;
  }
}
</style>
