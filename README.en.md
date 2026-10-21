# Kingdee SQL Server MCP

[简体中文](README.md) | **English**

A read-only MCP server that connects AI assistants to Microsoft SQL Server over stdio. It provides database metadata queries and read-only access to Kingdee Cloud Galaxy form structures and business documents.

## Features

The server exposes one tool, `kingdee_sqlserver`. Select an operation with the `action` parameter:

| Action | Purpose |
|---|---|
| `ping` | Check the SQL Server connection |
| `list_databases` | List databases visible to the configured SQL login |
| `list_tables` | List tables, optionally filtered by schema |
| `describe_table` | Inspect columns, data types, and basic table structure |
| `query_sql` | Run one or up to 50 read-only SELECT / CTE statements with bound parameters |
| `search_forms` | Search Kingdee forms by identifier or name |
| `form_structure` | Inspect form entities, fields, and related metadata |
| `read_bill` | Read document headers and entries by document number or internal ID |

## Security boundaries

- All database connections use the configured SQL login. Use a dedicated account with only the read permissions you need.
- `query_sql` accepts SELECT statements and read-only CTEs. Its validation rejects DML, DDL, stored procedure execution, administrative commands, comments, and external data source access.
- Bind values with `@p1`, `@p2`, and similar placeholders. Do not concatenate external input into SQL.
- Each call accepts at most 50 statements sharing a total result row budget. The default is `SQLSERVER_MAX_ROWS=500`; the configurable maximum is 5000.
- This public version does not expose write, deployment, form-field creation, or session termination actions.
- Direct database reads return stored values. They do not enforce Kingdee application-level permissions or business logic, or apply WebAPI formatting. Keep production credentials out of Git and chat messages.

## Requirements

- Node.js 20 or later
- A reachable SQL Server instance
- A database account with the required read permissions
- An AI client that supports MCP over stdio

## Installation and configuration

```powershell
npm install
Copy-Item .env.example .env
```

Edit the local `.env` file with your SQL Server address, database, and read-only account credentials. Do not commit `.env`.

| Setting | Description |
|---|---|
| `SQLSERVER_HOST` | SQL Server hostname or address |
| `SQLSERVER_PORT` | TCP port, usually 1433 |
| `SQLSERVER_INSTANCE` | Optional named instance |
| `SQLSERVER_DATABASE` | Default database |
| `KINGDEE_SQLSERVER_DATABASE` | Optional override for the query target database |
| `SQLSERVER_USER` / `SQLSERVER_PASSWORD` | Local read-only account credentials |
| `SQLSERVER_ENCRYPT` / `SQLSERVER_TRUST_SERVER_CERTIFICATE` | TLS connection options |
| `SQLSERVER_MAX_ROWS` | Maximum result rows per call, from 1 to 5000 |

Start the server:

```powershell
npm start
```

Your MCP client normally starts the server as a stdio subprocess. Example client configuration:

```toml
[mcp_servers.kingdee_sqlserver]
command = "node"
args = ["C:/path/to/kingdee-sqlserver-mcp/src/index.js"]
cwd = "C:/path/to/kingdee-sqlserver-mcp"
```

Replace these paths with the actual location of this repository. Restart your MCP client or start a new session after changing its configuration.

## Query examples

List tables in the `dbo` schema:

```json
{"action":"list_tables","schema":"dbo"}
```

Inspect a table:

```json
{"action":"describe_table","schema":"dbo","table":"T_SAL_ORDER"}
```

Run a parameterized query:

```json
{"action":"query_sql","query":"SELECT TOP (20) FID, FBILLNO FROM dbo.T_SAL_ORDER WHERE FBILLNO = @p1","parameters":{"p1":"SO-0001"}}
```

Search for a form by its identifier:

```json
{"action":"search_forms","keyword":"SAL_SaleOrder","limit":10}
```

Inspect the form and read a document:

```json
{"action":"form_structure","formId":"SAL_SaleOrder"}
```

```json
{"action":"read_bill","formId":"SAL_SaleOrder","billNumber":"SO-0001"}
```

Confirm the target database, filters, and data scope before calling the tool. Use narrow filters for large or sensitive datasets and follow your organization's data access policies.

## Troubleshooting

- `Missing required environment variable`: Check that `.env` exists and contains all required settings.
- `SQL Server connection failed`: Check the host, port or instance, TLS settings, firewall, and account permissions.
- Query rejected: Only read-only SELECT / CTE statements are supported. Check for comments, writes, or administrative commands.
- Form or document cannot be read: Check access to the Kingdee metadata and business tables, and verify the form identifier and lookup values.

## License

This repository does not include an open-source license. Public visibility does not grant permission to copy, modify, or distribute the code. Contact the repository maintainer to confirm authorization before adopting it.
