# Local Agent Automation MCP

A local MCP server for SQLite-backed TODOs and scheduled coding-agent jobs. MCP clients connect over stdio. A separate worker process runs the durable schedule, so stopping an editor or MCP client does not stop scheduled jobs.

## Requirements

- Bun 1.4.2 or newer. The project has been implemented and checked with Bun 1.4.2.
- Linux for the systemd user-service integration.
- An MCP-compatible editor/client.
- At least one supported agent CLI installed and authenticated for scheduled work.

`automation-mcp` is already published on npm by an unrelated project. This repository therefore uses the npm package name `local-agent-automation-mcp` and reserves `automation-mcp` as its CLI name. Confirm availability and update this package name before publishing. The GitHub repository is [brili99/automation-mcp](https://github.com/brili99/automation-mcp).

## Install

On macOS/Linux, the installer checks OS and architecture, bootstraps Bun 1.4.2 into the current user's Bun directory when necessary, installs the npm package through Bun, and verifies the CLI:

```sh
curl -fsSL https://raw.githubusercontent.com/brili99/automation-mcp/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/brili99/automation-mcp/main/install.ps1 | iex
```

The current PowerShell installer supports Windows x64 and ARM64. Bun's official installer may update the current user's PATH. Restart the terminal/editor if the new PATH is not visible. No Administrator or `sudo` privileges are required.

With Bun already installed, direct global installation is:

```sh
bun add --global local-agent-automation-mcp
```

Or use npm as the distribution client when Bun is already installed:

```sh
npm install --global local-agent-automation-mcp
```

The executable is `automation-mcp`. Bun is also required at runtime because the package uses `bun:sqlite`.

## Configure

Initialize a codebase from its Git repository or project directory:

```sh
cd /path/to/project
automation-mcp init
```

This creates `.automation/config.json` and `.automation/automation.sqlite` with private filesystem permissions, and adds the current repository root as an approved workspace. It is safe to rerun: existing configuration and database contents are preserved. Add `.automation/` to version control ignores; the repository `.gitignore` already does this. Commands run from the project or its subdirectories automatically discover the nearest `.automation/config.json`, so the MCP server, worker, and UI use this project database.

Without a project-local `.automation` directory, the first command creates `~/.config/automation-mcp/config.json` if it does not exist and uses the default database at `~/.local/share/automation-mcp/automation.sqlite`. Set `AUTOMATION_MCP_CONFIG` to choose another config file; it takes precedence over project discovery. `databasePath` can be absolute or relative to the config file. Existing config and database data are not overwritten. Jobs are created paused and are enabled only after the selected CLI passes version and workspace-sandbox preflight; explicit enable requests repeat that check.

Example configuration:

```json
{
	"workspaceRoots": ["/home/me/projects"],
	"memoryTokenBudget": 1200,
	"maxRunDurationMs": 3600000,
	"maxOutputBytes": 1048576,
	"runHistoryLimit": 500
}
```

Add only directories in which scheduled agents are allowed to work. Job workspaces must be canonical directories inside an approved root. Credentials are not stored by this application; use the agent's supported credential store or a documented environment variable. Prompts and adapter configuration reject credential-shaped content; agent output is redacted before it is written to run history. The database is plaintext and relies on user-only filesystem permissions, so back it up and protect it as local application data.

## MCP Client

The project includes `.vscode/mcp.json` for local stdio testing. A client can also launch the installed executable directly:

```json
{
	"servers": {
		"local-agent-automation": {
			"type": "stdio",
			"command": "automation-mcp",
			"args": ["mcp"]
		}
	}
}
```

The MCP process keeps stdout reserved for protocol messages and sends diagnostics to stderr. Long executions return a run ID; poll `run_status` or `run_history` rather than waiting for an agent call inside a tool request.

## TODOs And Jobs

TODOs are separate from scheduled jobs. Tools `todo_add`, `todo_list`, `todo_update`, `todo_complete`, `todo_cancel`, and `todo_delete` manage independent TODO records. The worker never claims TODOs.

Use `job_create` with an explicit `cronExpression` and IANA `timezone`; both values are saved as entered and are required again when updating a schedule. The service validates that the expression and timezone are valid but never invents or rewrites either. Missed schedule occurrences older than the short polling window are skipped after downtime. Duplicate scheduled occurrences are prevented by a database uniqueness constraint. At most one run is active globally, and there is at most one pending or active occurrence per job.

Other job tools list/update jobs, enable or pause schedules, queue `job_run_now`, inspect/cancel executions, and read/update/clear persistent memory. Updating a job preserves its prior enabled/paused state after adapter preflight; paused jobs keep their saved cron and timezone. A run queued while a job is paused is not claimed until the job is enabled again.

## Agent Adapters And Safety

- **OpenCode** runs `opencode run --auto` after verifying `run --help`. Its process gets a deny-by-default permission policy: read/search/edit within the working directory are allowed; shell, external directories, web access, and subagents are denied.
- **Codex** runs `codex exec --sandbox workspace-write --ask-for-approval never` after verifying the installed help advertises the required controls.
- **Antigravity** runs `agy -p --sandbox` only when its existing `~/.gemini/antigravity-cli/settings.json` validates `enableTerminalSandbox: true` and `toolPermission: "proceed-in-sandbox"`. The app does not modify this file. Set `allowNonWorkspaceAccess` to false or leave it unset.
- **Generic** profiles require an executable and argv array, never a shell command string. The argv must include `--sandbox workspace-write` and `{prompt}`; a non-interactive preflight invocation and required help markers must be explicitly configured and present in CLI help.

Agent processes use `spawn` with shell execution disabled, a separate workspace `cwd`, a restricted inherited environment, bounded runtime and combined output, and cancellation escalation. They must not commit, push, merge, or use unrestricted host access. A CLI that cannot verify its non-interactive workspace sandbox is reported unsupported and is not run. OpenCode, Codex, or Antigravity authentication stored only in a desktop keyring may be unavailable under a headless service; use that CLI's documented headless credential method without putting secrets in the SQLite database.

## Persistent Job Memory

Each job has its own structured note (`decisions`, `currentState`, `constraints`, `nextSteps`) stored separately from run history. A real GPT BPE tokenizer enforces the configurable `memoryTokenBudget` (default 1,200 tokens). The bounded note is included as untrusted task context in later runs, including after a worker restart; it is never treated as system policy or authorization.

Agent output may include the structured memory-update envelope. Invalid JSON, secrets, or an uncompactable update leaves the previous note unchanged. Compaction removes the oldest detail from list categories rather than truncating a note arbitrarily. `job_memory_get`, `job_memory_set`, and `job_memory_clear` allow inspection, explicit edits, per-job token-budget changes, and reset. Memory has an independent lifecycle and is not deleted by run-history retention.

## Dashboard

Start the read-only dashboard with:

```sh
automation-mcp ui
```

It binds only to `127.0.0.1` (default port `4177`), reads the same configured database, and reports worker health, jobs/schedules/next runs, active executions, and recent outcomes. It exposes no job mutation endpoints. Use `automation-mcp ui --port 4178` to choose another local port.

## Linux Worker Service

Install the systemd user unit and manage it without an interactive shell:

```sh
automation-mcp service install
automation-mcp service start
automation-mcp service status
automation-mcp service logs
automation-mcp service stop
```

The installer resolves Bun and records explicit executable, PATH, and config paths in `~/.config/systemd/user/automation-worker.service`. To run jobs after logout/reboot, enable lingering separately: `loginctl enable-linger "$USER"` (or run `automation-mcp service enable-lingering` for the instruction). The service runs as your account and shares its database with MCP and the dashboard.

## Backup And Recovery

Stop the worker before making a cold copy of the SQLite database, or use SQLite's online backup API/tool while it is live. Include the database's `-wal` file if copying files directly while a process is open; do not treat the main database file alone as a live backup. Protect backups like the original plaintext data. On worker restart, abandoned active runs are marked interrupted rather than replayed. Schedule occurrence records are idempotent.

## Development And Verification

```sh
bun install
bun run typecheck
bun run lint
bun test
bun run build
```

The typecheck uses the shared strict configuration for source and tests. The test suite uses temporary SQLite databases and fake processes; it makes no paid agent calls. `bun run check` runs all local quality gates.

## Troubleshooting

- `automation-mcp: command not found`: add Bun's global executable directory to PATH; on macOS/Linux this is usually `~/.bun/bin`, and on Windows it is under `%USERPROFILE%\.bun\bin`.
- `No approved workspace roots`: add an absolute path in `workspaceRoots`, then create or update the job with a directory inside it.
- Adapter preflight says unsupported: install/update the agent CLI and verify its documented non-interactive sandbox flags; do not remove safety flags to make it pass.
- Antigravity does not start unattended: authenticate using a documented headless method and set the sandbox keys above in its own settings file.
- Worker status is stale: run `automation-mcp service status` and `automation-mcp service logs`; user keyrings may not be available in a headless session.
- Database is locked: verify there is only one worker, keep the same configured database path for all processes, and allow the 5-second SQLite busy timeout to handle brief contention.
- `automation-mcp` npm package name: it belongs to another publisher; install this project by its distinct package name until a verified package name change is made.

## SDK References

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official server tools guide](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools)
- [MCP stdio serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
- [Cron parser](https://github.com/harrisiirak/cron-parser)
- [Antigravity sandbox](https://antigravity.google/docs/sandbox?tab=cli)