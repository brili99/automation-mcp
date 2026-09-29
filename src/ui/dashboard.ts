import type { Database } from 'bun:sqlite';
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { JobRepository } from '../scheduler/jobs.js';
import { RunRepository } from '../scheduler/runs.js';
import { nextOccurrence, validateSchedule } from '../scheduler/schedule.js';

const workerRowSchema = z.object({
  worker_id: z.string(),
  pid: z.number().int(),
  started_at: z.string().datetime({ offset: true }),
  heartbeat_at: z.string().datetime({ offset: true }),
});

export type DashboardOptions = {
  hostname?: string;
  port?: number;
};

export type DashboardSnapshot = {
  generatedAt: string;
  worker: {
    healthy: boolean;
    workerId: string | null;
    pid: number | null;
    startedAt: string | null;
    heartbeatAt: string | null;
  };
  jobs: Array<{
    id: string;
    name: string;
    enabled: boolean;
    workspace: string;
    cronExpression: string;
    timezone: string;
    nextRun: string | null;
  }>;
  activeRuns: Array<{
    id: string;
    jobId: string;
    status: string;
    startedAt: string | null;
    createdAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    jobId: string;
    status: string;
    finishedAt: string | null;
    createdAt: string;
    exitCode: number | null;
  }>;
};

export function readDashboardSnapshot(database: Database, now = new Date()): DashboardSnapshot {
  const workerRaw = database.query('SELECT * FROM worker_state WHERE singleton = 1').get();
  const worker = workerRaw === null ? null : workerRowSchema.parse(workerRaw);
  const workerHealthy =
    worker !== null && now.getTime() - Date.parse(worker.heartbeat_at) <= 30_000;
  const jobs = new JobRepository(database, []).list().map((job) => {
    let nextRun: string | null = null;
    if (job.enabled) {
      try {
        nextRun = nextOccurrence(
          validateSchedule(job.cronExpression, job.timezone),
          now,
        ).toISOString();
      } catch {
        nextRun = null;
      }
    }
    return {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      workspace: job.workspace,
      cronExpression: job.cronExpression,
      timezone: job.timezone,
      nextRun,
    };
  });
  const runs = new RunRepository(database);
  return {
    generatedAt: now.toISOString(),
    worker: {
      healthy: workerHealthy,
      workerId: worker?.worker_id ?? null,
      pid: worker?.pid ?? null,
      startedAt: worker?.started_at ?? null,
      heartbeatAt: worker?.heartbeat_at ?? null,
    },
    jobs,
    activeRuns: runs
      .list(undefined, 500)
      .filter((run) => run.status === 'running' || run.status === 'queued')
      .map(({ id, jobId, status, startedAt, createdAt }) => ({
        id,
        jobId,
        status,
        startedAt,
        createdAt,
      })),
    recentRuns: runs
      .list(undefined, 30)
      .map(({ id, jobId, status, finishedAt, createdAt, exitCode }) => ({
        id,
        jobId,
        status,
        finishedAt,
        createdAt,
        exitCode,
      })),
  };
}

export function createDashboardHandler(database: Database): (request: Request) => Response {
  return (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const hostResponse = hostHeaderValidationResponse(request, localhostAllowedHostnames());
    if (hostResponse !== undefined) {
      return hostResponse;
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/status') {
      return Response.json(readDashboardSnapshot(database), {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 });
    }
    return new Response(DASHBOARD_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  };
}

export function startDashboard(
  database: Database,
  options: DashboardOptions = {},
): ReturnType<typeof Bun.serve> {
  const hostname = z.literal('127.0.0.1').default('127.0.0.1').parse(options.hostname);
  const port = z.number().int().min(1).max(65535).default(4177).parse(options.port);
  return Bun.serve({ hostname, port, fetch: createDashboardHandler(database) });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Automation Status</title>
  <style>
    :root { color-scheme: light; --ink: #14211f; --muted: #5e6b68; --line: #d9dfda; --paper: #f3f5ef; --white: #fff; --green: #1c7658; --red: #a64738; --amber: #986c1d; --blue: #356c86; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: repeating-linear-gradient(0deg, transparent 0 31px, rgba(20,33,31,.035) 31px 32px), var(--paper); font: 15px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px clamp(18px, 4vw, 56px); border-bottom: 1px solid var(--line); background: rgba(255,255,255,.78); }
    h1 { margin: 0; font: 700 20px/1.1 Georgia, 'Times New Roman', serif; letter-spacing: 0; }
    .refresh { color: var(--muted); font-size: 12px; white-space: nowrap; }
    main { max-width: 1440px; margin: auto; padding: 28px clamp(18px, 4vw, 56px) 64px; }
    .topline { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid var(--ink); padding-bottom: 10px; margin-bottom: 24px; }
    .topline h2 { margin: 0; font: 700 16px Georgia, 'Times New Roman', serif; }
    .worker { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--red); }
    .dot.ok { background: var(--green); }
    .section { margin-top: 34px; }
    .section h3 { margin: 0 0 10px; font: 700 13px Georgia, 'Times New Roman', serif; }
    .table-wrap { overflow-x: auto; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: rgba(255,255,255,.65); }
    table { width: 100%; min-width: 780px; border-collapse: collapse; text-align: left; }
    th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 11px; font-weight: 500; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    .status { display: inline-flex; align-items: center; gap: 6px; }
    .pill { display: inline-block; border: 1px solid currentColor; padding: 2px 6px; font-size: 11px; line-height: 1.2; }
    .succeeded { color: var(--green); } .failed, .interrupted { color: var(--red); } .queued { color: var(--amber); } .running { color: var(--blue); } .cancelled { color: var(--muted); }
    .path { overflow-wrap: anywhere; color: var(--muted); }
    .empty { padding: 16px 12px; color: var(--muted); }
    footer { margin-top: 28px; color: var(--muted); font-size: 11px; }
    @media (max-width: 600px) { header { align-items: flex-start; flex-direction: column; gap: 8px; } main { padding-top: 20px; } .topline { align-items: flex-start; flex-direction: column; gap: 12px; } }
  </style>
</head>
<body>
  <header><h1>Automation Status</h1><span class="refresh" id="updated">Connecting...</span></header>
  <main>
    <div class="topline"><h2>Worker</h2><span class="worker"><i class="dot" id="worker-dot"></i><span id="worker-state">Checking</span></span></div>
    <p id="worker-detail" class="path">No worker information.</p>
    <section class="section"><h3>Scheduled jobs</h3><div class="table-wrap"><table><thead><tr><th>Job</th><th>State</th><th>Workspace</th><th>Schedule</th><th>Next run</th></tr></thead><tbody id="jobs"></tbody></table></div></section>
    <section class="section"><h3>Active executions</h3><div class="table-wrap"><table><thead><tr><th>Execution</th><th>Job</th><th>State</th><th>Started</th></tr></thead><tbody id="active"></tbody></table></div></section>
    <section class="section"><h3>Recent outcomes</h3><div class="table-wrap"><table><thead><tr><th>Execution</th><th>Job</th><th>State</th><th>Finished</th><th>Exit</th></tr></thead><tbody id="history"></tbody></table></div></section>
    <footer>Read-only status view · data remains in the configured local SQLite database</footer>
  </main>
  <script>
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const formatTime = value => value ? new Date(value).toLocaleString() : '—';
    const row = (cells) => '<tr>' + cells.map(cell => '<td>' + cell + '</td>').join('') + '</tr>';
    const empty = columns => '<tr><td class="empty" colspan="' + columns + '">Nothing to show</td></tr>';
    async function refresh() {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Status request failed (' + response.status + ')');
        const data = await response.json();
        document.getElementById('updated').textContent = 'Updated ' + formatTime(data.generatedAt);
        document.getElementById('worker-dot').className = 'dot' + (data.worker.healthy ? ' ok' : '');
        document.getElementById('worker-state').textContent = data.worker.healthy ? 'Healthy' : 'Not running';
        document.getElementById('worker-detail').textContent = data.worker.healthy ? 'PID ' + data.worker.pid + ' · heartbeat ' + formatTime(data.worker.heartbeatAt) : 'No recent worker heartbeat.';
        document.getElementById('jobs').innerHTML = data.jobs.length ? data.jobs.map(job => row([
          escapeHtml(job.name), '<span class="pill ' + (job.enabled ? 'succeeded' : 'cancelled') + '">' + (job.enabled ? 'enabled' : 'paused') + '</span>',
          '<span class="path">' + escapeHtml(job.workspace) + '</span>', escapeHtml(job.cronExpression) + '<br><span class="path">' + escapeHtml(job.timezone) + '</span>', formatTime(job.nextRun)
        ])).join('') : empty(5);
        const jobsById = new Map(data.jobs.map(job => [job.id, job.name]));
        document.getElementById('active').innerHTML = data.activeRuns.length ? data.activeRuns.map(run => row([
          escapeHtml(run.id), escapeHtml(jobsById.get(run.jobId) || run.jobId), '<span class="pill ' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</span>', formatTime(run.startedAt)
        ])).join('') : empty(4);
        document.getElementById('history').innerHTML = data.recentRuns.length ? data.recentRuns.map(run => row([
          escapeHtml(run.id), escapeHtml(jobsById.get(run.jobId) || run.jobId), '<span class="pill ' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</span>', formatTime(run.finishedAt || run.createdAt), run.exitCode === null ? '—' : escapeHtml(run.exitCode)
        ])).join('') : empty(5);
      } catch (error) {
        document.getElementById('updated').textContent = error instanceof Error ? error.message : 'Unable to read status';
      }
    }
    void refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
