# github-core-clone-01

Standalone GitHub-compatible git forge providing Git Smart HTTP, REST v3, GraphQL v4, and MCP from a single Node 22 process using standard library only.

## Features & Protocol Support
- **Git Smart HTTP**: Full repository cloning, pulling, and pushing support (`info/refs`, `git-upload-pack`, `git-receive-pack`).
- **REST API v3**: GitHub-compatible REST endpoints for repositories, issues, pulls, and users.
- **GraphQL API v4**: Flexible query and mutation interface mimicking GitHub GraphQL schema.
- **Model Context Protocol (MCP)**: Native MCP server integration for LLM agent workflows and tool invocation.
- **Zero Dependencies**: Built entirely using the Node.js 22 standard library with TypeScript type stripping (`erasableSyntaxOnly`).

## Configuration & Usage
Start the forge with Node 22:
```bash
node main.ts
```

### Environment Variables
- `MAKEFUN_ENV_URL`: Base URL configuration for forge routing and webhooks.
- `PORT`: Optional port override (defaults according to application setup).

