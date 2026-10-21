# Kingdee SQL Server MCP

**简体中文** | [English](README.en.md)

一个通过 MCP stdio 连接 Microsoft SQL Server 的只读服务，为支持 MCP 的 AI 助手提供 SQL Server 元数据查询，以及金蝶云星空表单结构和单据只读查看能力。

## 功能

服务通过统一工具 `kingdee_sqlserver` 的 `action` 参数提供以下操作：

| 操作 | 用途 |
|---|---|
| `ping` | 检查 SQL Server 连接 |
| `list_databases` | 列出当前 SQL 登录可见的数据库 |
| `list_tables` | 列出指定 schema 的表 |
| `describe_table` | 查看表字段、类型和基本结构 |
| `query_sql` | 执行一条或最多 50 条只读 SELECT / CTE 查询，支持参数绑定 |
| `search_forms` | 按表单编号或名称搜索金蝶表单 |
| `form_structure` | 查看表单实体、字段及关联元数据 |
| `read_bill` | 按单据编号或内部 ID 只读读取单据表头与分录 |

## 安全边界

- 只使用配置的 SQL 登录连接数据库。请创建并使用权限受限的只读账号。
- `query_sql` 只接受 `SELECT` 和只读 CTE；拒绝 DML、DDL、存储过程、管理命令、注释及外部数据源访问。
- 查询参数通过 `@p1`、`@p2` 等绑定，不要把外部输入拼接进 SQL。
- 每次调用最多 50 条查询，共用结果行数上限；默认 `SQLSERVER_MAX_ROWS=500`，最大可配置到 5000。
- 本公开版本不包含写入、部署、表单字段创建或会话终止动作。
- 直连数据库返回的是存储值，不会代替金蝶业务权限、业务逻辑或 WebAPI 格式化处理。请勿将生产数据库凭据提交到仓库或聊天中。

## 要求

- Node.js 20 或更高版本
- 可连接的 SQL Server
- 具有所需只读权限的数据库账号
- 一个支持 MCP stdio 的 AI 客户端

## 安装与配置

```powershell
npm install
Copy-Item .env.example .env
```

编辑本机 `.env`，设置 SQL Server 地址、数据库、只读用户名和密码。不要提交 `.env`。连接选项说明：

- `SQLSERVER_HOST`：SQL Server 主机名或地址
- `SQLSERVER_PORT`：TCP 端口，通常为 1433
- `SQLSERVER_INSTANCE`：可选命名实例
- `SQLSERVER_DATABASE`：默认数据库
- `KINGDEE_SQLSERVER_DATABASE`：可选的查询目标数据库覆盖项
- `SQLSERVER_USER` / `SQLSERVER_PASSWORD`：本机只读账号凭据
- `SQLSERVER_ENCRYPT` / `SQLSERVER_TRUST_SERVER_CERTIFICATE`：TLS 连接选项
- `SQLSERVER_MAX_ROWS`：单次调用最多返回的行数，范围 1–5000

启动服务：

```powershell
npm start
```

MCP 客户端会以 stdio 子进程方式启动服务。配置示例：

```toml
[mcp_servers.kingdee_sqlserver]
command = "node"
args = ["C:/path/to/kingdee-sqlserver-mcp/src/index.js"]
cwd = "C:/path/to/kingdee-sqlserver-mcp"
```

将路径换成此仓库在本机的实际位置。保存配置后，重启 MCP 客户端或新建会话以加载工具。

## 查询示例

列出 `dbo` 下的表：

```json
{"action":"list_tables","schema":"dbo"}
```

查看表结构：

```json
{"action":"describe_table","schema":"dbo","table":"T_SAL_ORDER"}
```

参数化查询：

```json
{"action":"query_sql","query":"SELECT TOP (20) FID, FBILLNO FROM dbo.T_SAL_ORDER WHERE FBILLNO = @p1","parameters":{"p1":"SO-0001"}}
```

搜索表单和读取单据：

```json
{"action":"search_forms","keyword":"销售订单","limit":10}
{"action":"form_structure","formId":"SAL_SaleOrder"}
{"action":"read_bill","formId":"SAL_SaleOrder","billNumber":"SO-0001"}
```

调用前应确认目标数据库、查询条件和数据范围。对大量或敏感数据先缩小过滤条件，并遵守所在组织的数据访问政策。

## 故障排查

- `Missing required environment variable`：检查 `.env` 是否存在且配置了必填项。
- `SQL Server connection failed`：检查主机、端口/实例、TLS 选项、防火墙和账号权限。
- 查询被拒绝：仅支持只读 SELECT/CTE；检查 SQL 中是否含注释、写操作或管理语句。
- 无法读取表单/单据：确认 SQL 登录能访问金蝶元数据及相关业务表，并检查表单编号和过滤值。

## 许可

仓库未附带开源许可证。公开可见不代表授予复制、修改或分发许可；如需采用，请先联系仓库维护者确认授权。
