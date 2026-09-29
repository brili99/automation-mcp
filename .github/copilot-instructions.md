# Local Agent Automation MCP

- Use Bun 1.4.2 or newer for runtime, scripts, and SQLite access.
- Keep MCP protocol messages on stdout; send diagnostics to stderr.
- Validate configuration, SQLite rows, and agent output at their boundaries.
- Keep unattended agent execution inside explicitly approved workspace roots and sandbox policies.
- Do not persist credentials, secrets, or full agent transcripts.
- Preserve the strict shared TypeScript options in `tsconfig.json` for every module.

## References

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official MCP TypeScript SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP server quickstart](https://modelcontextprotocol.io/docs/develop/build-server)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)