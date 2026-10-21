import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { splitReadOnlyStatements, validateReadOnlyQuery } from './read-only-query.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const config = {
  server: required('SQLSERVER_HOST'),
  port: optionalNumber('SQLSERVER_PORT'),
  database: process.env.KINGDEE_SQLSERVER_DATABASE || process.env.SQLSERVER_DATABASE || 'master',
  user: required('SQLSERVER_USER'),
  password: required('SQLSERVER_PASSWORD'),
  connectionTimeout: numberOr('SQLSERVER_CONNECTION_TIMEOUT_MS', 15000),
  requestTimeout: numberOr('SQLSERVER_QUERY_TIMEOUT_MS', 30000),
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  options: {
    encrypt: boolOr('SQLSERVER_ENCRYPT', false),
    trustServerCertificate: boolOr('SQLSERVER_TRUST_SERVER_CERTIFICATE', true),
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    enableArithAbort: true,
  },
};

const maxRows = Math.min(Math.max(numberOr('SQLSERVER_MAX_ROWS', 500), 1), 5000);
let poolPromise;
const server = new McpServer({ name: 'kingdee-sqlserver-mcp', version: '1.0.0' });
const internalTools = new Map();
function registerInternalTool(name, definition, handler) {
  internalTools.set(name, { definition, handler });
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function numberOr(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function optionalNumber(name) {
  return process.env[name] ? numberOr(name, undefined) : undefined;
}
function boolOr(name, fallback) {
  const value = process.env[name]?.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
function getPool() {
  poolPromise ??= new sql.ConnectionPool(config).connect().catch((error) => {
    poolPromise = undefined;
    throw new Error(`SQL Server connection failed: ${error.message}`);
  });
  return poolPromise;
}

function resultText(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
registerInternalTool('sqlserver_ping', {
  description: 'Test the configured SQL Server connection and return server/database identity.',
  inputSchema: {},
}, async () => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name,
           SUSER_SNAME() AS login_name, SYSUTCDATETIME() AS checked_at_utc
  `);
  return resultText(result.recordset[0]);
});

registerInternalTool('sqlserver_list_databases', {
  description: 'List databases visible to the configured SQL login (read-only).',
  inputSchema: {},
}, async () => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT name, state_desc, create_date
    FROM sys.databases
    WHERE HAS_DBACCESS(name) = 1
    ORDER BY name
  `);
  return resultText(result.recordset);
});

registerInternalTool('sqlserver_list_tables', {
  description: 'List tables in the configured database, optionally filtered by schema.',
  inputSchema: { schema: z.string().optional().describe('Schema name, such as dbo') },
}, async ({ schema }) => {
  const pool = await getPool();
  const request = pool.request();
  let filter = '';
  if (schema) {
    request.input('schema', sql.NVarChar(128), schema);
    filter = 'AND s.name = @schema';
  }
  const result = await request.query(`
    SELECT s.name AS schema_name, t.name AS table_name,
           SUM(p.rows) AS approx_row_count
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    WHERE t.is_ms_shipped = 0 ${filter}
    GROUP BY s.name, t.name
    ORDER BY s.name, t.name
  `);
  return resultText(result.recordset);
});

registerInternalTool('sqlserver_describe_table', {
  description: 'Show columns and basic metadata for a table in the configured database.',
  inputSchema: {
    schema: z.string().default('dbo'),
    table: z.string().min(1),
  },
}, async ({ schema, table }) => {
  const pool = await getPool();
  const request = pool.request()
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table);
  const result = await request.query(`
    SELECT c.column_id, c.name AS column_name,
           TYPE_NAME(c.user_type_id) AS data_type,
           c.max_length, c.precision, c.scale,
           c.is_nullable, c.is_identity,
           OBJECT_DEFINITION(c.default_object_id) AS default_definition
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = @schema AND t.name = @table
    ORDER BY c.column_id
  `);
  if (!result.recordset.length) throw new Error(`Table not found or not visible: ${schema}.${table}`);
  return resultText(result.recordset);
});

registerInternalTool('kingdee_search_forms', {
  description: 'Search Kingdee Cloud Galaxy forms by form ID, Chinese name, or base object ID. Reads T_META_OBJECTTYPE and localized names.',
  inputSchema: {
    keyword: z.string().min(1).describe('Form ID or a word from the form name, for example SAL_SaleOrder or 销售订单.'),
    localeId: z.number().int().positive().default(2052).describe('Locale ID; 2052 is Simplified Chinese.'),
    limit: z.number().int().min(1).max(100).default(20),
  },
}, async ({ keyword, localeId, limit }) => {
  const pool = await getPool();
  const result = await pool.request()
    .input('pattern', sql.NVarChar(256), `%${keyword}%`)
    .input('exact', sql.NVarChar(128), keyword)
    .input('locale', sql.Int, localeId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
             o.FID AS form_id, l.FNAME AS form_name,
             o.FMODELTYPEID AS model_type_id, o.FSUBSYSID AS subsystem_id,
             o.FBASEOBJECTID AS base_object_id, o.FVERSION AS version,
             o.FISTEMPLATE AS is_template
      FROM dbo.T_META_OBJECTTYPE o
      LEFT JOIN dbo.T_META_OBJECTTYPE_L l ON l.FID = o.FID AND l.FLOCALEID = @locale
      WHERE o.FMODELTYPEID IN (100, 200, 300, 400, 900)
        AND (o.FID LIKE @pattern OR COALESCE(l.FNAME, N'') LIKE @pattern OR COALESCE(o.FBASEOBJECTID, '') LIKE @pattern)
      ORDER BY CASE WHEN o.FID = @exact THEN 0 ELSE 1 END,
               CASE WHEN l.FNAME = @exact THEN 0 ELSE 1 END,
               COALESCE(l.FNAME, N''), o.FID
    `);
  return resultText({ count: result.recordset.length, forms: result.recordset });
});

registerInternalTool('kingdee_get_form_structure', {
  description: 'Read a Kingdee form definition from T_META_OBJECTTYPE, including entities, physical tables, and field keys/names/types.',
  inputSchema: {
    formId: z.string().min(1).describe('Kingdee form ID, for example SAL_SaleOrder.'),
    localeId: z.number().int().positive().default(2052),
    fieldLimit: z.number().int().min(1).max(500).default(maxRows),
  },
}, async ({ formId, localeId, fieldLimit }) => {
  const pool = await getPool();
  const meta = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .input('locale', sql.Int, localeId)
    .query(`
      SELECT TOP (1) o.FID AS form_id, l.FNAME AS form_name,
             o.FMODELTYPEID AS model_type_id, o.FSUBSYSID AS subsystem_id,
             o.FBASEOBJECTID AS base_object_id, o.FVERSION AS version,
             o.FISTEMPLATE AS is_template
      FROM dbo.T_META_OBJECTTYPE o
      LEFT JOIN dbo.T_META_OBJECTTYPE_L l ON l.FID = o.FID AND l.FLOCALEID = @locale
      WHERE o.FID = @formId
    `);
  if (!meta.recordset.length) throw new Error(`Kingdee form metadata not found: ${formId}`);

  const entities = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .query(`
      SELECT E.N.value('local-name(.)','nvarchar(128)') AS entity_type,
             NULLIF(E.N.value('(Key/text())[1]','nvarchar(128)'), '') AS entity_key,
             NULLIF(E.N.value('(Name/text())[1]','nvarchar(256)'), '') AS entity_name,
             NULLIF(E.N.value('(EntryName/text())[1]','nvarchar(128)'), '') AS entry_name,
             NULLIF(E.N.value('(TableName/text())[1]','nvarchar(128)'), '') AS physical_table,
             NULLIF(E.N.value('(EntryPkFieldName/text())[1]','nvarchar(128)'), '') AS primary_key_field,
             NULLIF(E.N.value('(SeqFieldKey/text())[1]','nvarchar(128)'), '') AS sequence_field
      FROM dbo.T_META_OBJECTTYPE o
      CROSS APPLY o.FKERNELXML.nodes('/FormMetadata/BusinessInfo/BusinessInfo/Elements/child::*') E(N)
      WHERE o.FID = @formId
        AND E.N.value('local-name(.)','nvarchar(128)') IN ('HeadEntity','EntryEntity')
      ORDER BY E.N.value('local-name(.)','nvarchar(128)'),
               E.N.value('(Key/text())[1]','nvarchar(128)')
    `);

  const fields = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .input('fieldLimit', sql.Int, fieldLimit)
    .query(`
      SELECT TOP (@fieldLimit)
             E.N.value('local-name(.)','nvarchar(128)') AS element_type,
             NULLIF(E.N.value('(Key/text())[1]','nvarchar(128)'), '') AS field_key,
             NULLIF(E.N.value('(PropertyName/text())[1]','nvarchar(128)'), '') AS property_name,
             NULLIF(E.N.value('(FieldName/text())[1]','nvarchar(128)'), '') AS physical_field,
             NULLIF(E.N.value('(Name/text())[1]','nvarchar(256)'), '') AS display_name,
             NULLIF(E.N.value('(FieldType/text())[1]','nvarchar(128)'), '') AS field_type,
             NULLIF(E.N.value('(MustInput/text())[1]','nvarchar(10)'), '') AS required
      FROM dbo.T_META_OBJECTTYPE o
      CROSS APPLY o.FKERNELXML.nodes('/FormMetadata/BusinessInfo/BusinessInfo/Elements/child::*') E(N)
      WHERE o.FID = @formId
        AND E.N.value('local-name(.)','nvarchar(128)') LIKE '%Field'
      ORDER BY E.N.value('(PropertyName/text())[1]','nvarchar(128)'),
               E.N.value('(Key/text())[1]','nvarchar(128)')
    `);

  const references = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .query(`
      SELECT FTABLENAME AS physical_table, FFIELDNAME AS physical_field,
             FREFOBJECTTYPEID AS referenced_form_id
      FROM dbo.T_META_OBJECTTYPEREF
      WHERE FOBJECTTYPEID = @formId
      ORDER BY FTABLENAME, FFIELDNAME
    `);
  return resultText({
    form: meta.recordset[0],
    entities: entities.recordset,
    field_count_returned: fields.recordset.length,
    field_limit: fieldLimit,
    fields: fields.recordset,
    reference_count: references.recordset.length,
    references: references.recordset,
  });
});

registerInternalTool('kingdee_read_bill', {
  description: 'Find a Kingdee bill by form ID plus bill number or internal ID, then read its header and metadata-defined entry entities. Read-only.',
  inputSchema: {
    formId: z.string().min(1).describe('Kingdee form ID, for example SAL_SaleOrder.'),
    billNumber: z.string().min(1).optional().describe('Exact bill number, such as FBillNo.'),
    id: z.string().min(1).optional().describe('Internal bill FID. Use when the bill number is duplicated.'),
    localeId: z.number().int().positive().default(2052),
    entryRowLimit: z.number().int().min(1).max(maxRows).default(Math.min(maxRows, 100)),
  },
}, async ({ formId, billNumber, id, localeId, entryRowLimit }) => {
  if (Boolean(billNumber) === Boolean(id)) throw new Error('Provide exactly one of billNumber or id.');
  const pool = await getPool();
  const meta = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .input('locale', sql.Int, localeId)
    .query(`
      SELECT TOP (1) o.FID AS form_id, l.FNAME AS form_name,
             o.FMODELTYPEID AS model_type_id, o.FSUBSYSID AS subsystem_id,
             o.FBASEOBJECTID AS base_object_id
      FROM dbo.T_META_OBJECTTYPE o
      LEFT JOIN dbo.T_META_OBJECTTYPE_L l ON l.FID=o.FID AND l.FLOCALEID=@locale
      WHERE o.FID=@formId
    `);
  if (!meta.recordset.length) throw new Error(`Kingdee form metadata not found: ${formId}`);

  const entityResult = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .query(`
      SELECT E.N.value('local-name(.)','nvarchar(128)') AS entity_type,
             NULLIF(E.N.value('(Key/text())[1]','nvarchar(128)'), '') AS entity_key,
             NULLIF(E.N.value('(Name/text())[1]','nvarchar(256)'), '') AS entity_name,
             NULLIF(E.N.value('(TableName/text())[1]','nvarchar(128)'), '') AS physical_table,
             NULLIF(E.N.value('(EntryPkFieldName/text())[1]','nvarchar(128)'), '') AS primary_key_field,
             NULLIF(E.N.value('(SeqFieldKey/text())[1]','nvarchar(128)'), '') AS sequence_field
      FROM dbo.T_META_OBJECTTYPE o
      CROSS APPLY o.FKERNELXML.nodes('/FormMetadata/BusinessInfo/BusinessInfo/Elements/child::*') E(N)
      WHERE o.FID=@formId AND E.N.value('local-name(.)','nvarchar(128)') IN ('HeadEntity','EntryEntity')
    `);
  const entities = entityResult.recordset;
  const head = entities.find((entity) => entity.entity_type === 'HeadEntity' && entity.physical_table);
  if (!head) throw new Error(`No physical header table was defined for form ${formId}.`);
  const safeIdentifier = /^[A-Za-z0-9_]+$/;
  if (!safeIdentifier.test(head.physical_table)) throw new Error('Metadata contains an invalid physical table name.');

  const columnResult = await pool.request()
    .input('tableName', sql.NVarChar(128), head.physical_table)
    .query(`
      SELECT c.name AS column_name, t.name AS data_type
      FROM sys.columns c
      JOIN sys.types t ON t.user_type_id=c.user_type_id
      WHERE c.object_id=OBJECT_ID(N'dbo.' + @tableName)
    `);
  const headColumns = columnResult.recordset;
  const normalizedColumn = (name) => headColumns.find((column) => column.column_name.toUpperCase() === name);
  const billNoColumn = normalizedColumn('FBILLNO') || normalizedColumn('FNUMBER');
  const idColumn = normalizedColumn('FID') || headColumns.find((column) => column.column_name.toUpperCase() === (head.primary_key_field || '').toUpperCase());
  const lookupColumn = billNumber ? billNoColumn : idColumn;
  if (!lookupColumn) throw new Error(billNumber
    ? `No FBILLNO/FNUMBER column exists in ${head.physical_table}.`
    : `No FID/internal key column exists in ${head.physical_table}.`);

  const headerRequest = pool.request();
  if (billNumber) headerRequest.input('lookup', sql.NVarChar(256), billNumber);
  else headerRequest.input('lookup', sql.NVarChar(128), id);
  const headerQuery = `SELECT TOP (2) * FROM [dbo].[${head.physical_table}] WHERE [${lookupColumn.column_name}] = @lookup ORDER BY [${idColumn?.column_name || lookupColumn.column_name}] DESC`;
  const headerResult = await headerRequest.query(headerQuery);
  if (!headerResult.recordset.length) return resultText({ found: false, form: meta.recordset[0], lookup: { [billNumber ? 'billNumber' : 'id']: billNumber || id } });
  if (headerResult.recordset.length > 1) {
    const candidates = headerResult.recordset.map((row) => ({
      id: row[idColumn?.column_name || 'FID'],
      bill_number: row[billNoColumn?.column_name || 'FBILLNO'],
      date: row.FDATE ?? row.FDate ?? null,
      document_status: row.FDOCUMENTSTATUS ?? row.FDocumentStatus ?? null,
      organization_id: row.FSALEORGID ?? row.FSTOCKORGID ?? row.FCREATEORGID ?? null,
    }));
    return resultText({ found: true, ambiguous: true, form: meta.recordset[0], candidates, hint: 'Several documents share this number; call again with id.' });
  }

  const header = headerResult.recordset[0];
  const documentId = header[idColumn?.column_name || 'FID'];
  const entries = [];
  const skippedEntries = [];
  const seenTables = new Set();
  for (const entity of entities) {
    if (entity.entity_type !== 'EntryEntity' || !entity.physical_table || seenTables.has(entity.physical_table)) continue;
    seenTables.add(entity.physical_table);
    if (!safeIdentifier.test(entity.physical_table)) {
      skippedEntries.push({ ...entity, reason: 'invalid table identifier in metadata' });
      continue;
    }
    const columns = await pool.request()
      .input('tableName', sql.NVarChar(128), entity.physical_table)
      .query(`SELECT c.name AS column_name FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.' + @tableName)`);
    const parentColumn = columns.recordset.find((column) => column.column_name.toUpperCase() === 'FID');
    if (!parentColumn) {
      skippedEntries.push({ ...entity, reason: 'no FID parent column found' });
      continue;
    }
    const entryRequest = pool.request()
      .input('documentId', sql.NVarChar(128), String(documentId))
      .input('rowLimit', sql.Int, entryRowLimit);
    const sequence = entity.sequence_field && columns.recordset.find((column) => column.column_name.toUpperCase() === entity.sequence_field.toUpperCase());
    const orderBy = sequence ? ` ORDER BY [${sequence.column_name}]` : '';
    const rows = await entryRequest.query(`SELECT TOP (@rowLimit) * FROM [dbo].[${entity.physical_table}] WHERE [${parentColumn.column_name}] = @documentId${orderBy}`);
    entries.push({ entity_key: entity.entity_key, entity_name: entity.entity_name, physical_table: entity.physical_table, row_count: rows.recordset.length, rows: rows.recordset });
  }
  return resultText({ found: true, ambiguous: false, form: meta.recordset[0], header, entries, skipped_entries: skippedEntries, entry_row_limit: entryRowLimit });
});

registerInternalTool('sqlserver_query_readonly', {
  description: `Run up to 50 semicolon-separated read-only SELECT/CTE statements. No DML/DDL, comments, or stored procedure execution. Results share a total cap of ${maxRows} rows per call. Use @p1, @p2, ... placeholders and provide matching JSON parameters.`,
  inputSchema: {
    query: z.string().min(1).describe('One or more SELECT/read-only CTE statements separated by semicolons (maximum 50); use @p1, @p2, ... for values.'),
    parameters: z.record(z.unknown()).optional().describe('Named scalar parameters, for example {"p1":"ABC","p2":10}.'),
  },
}, async ({ query, parameters = {} }) => {
  const statements = splitReadOnlyStatements(query);
  statements.forEach(validateReadOnlyQuery);
  const pool = await getPool();
  const request = pool.request();
  request.input('__mcp_limit', sql.Int, maxRows);
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^p\d+$/.test(name)) throw new Error(`Invalid parameter name: ${name}; use p1, p2, ...`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Parameter ${name} must be a string, number, boolean, or null.`);
    }
    if (value === null) request.input(name, sql.NVarChar, value);
    else request.input(name, value);
  }
  const markerPrefix = `__MCP_RESULT_${randomUUID()}_`;
  let batch = `DECLARE @__mcp_budget int = @__mcp_limit;\nDECLARE @__mcp_count int;\nDECLARE @__mcp_row_limit int;\n`;
  statements.forEach((statement, index) => {
    batch += `\nSET @__mcp_count = -1;\nIF @__mcp_budget > 0\nBEGIN\n  SET @__mcp_row_limit = @__mcp_budget + 1;\n  SET ROWCOUNT @__mcp_row_limit;\n  BEGIN TRY\n    ${statement};\n    SET @__mcp_count = @@ROWCOUNT;\n  END TRY\n  BEGIN CATCH\n    SET ROWCOUNT 0;\n    THROW;\n  END CATCH;\n  SET ROWCOUNT 0;\nEND;\nSELECT N'${markerPrefix}${index + 1}' AS __mcp_marker, @__mcp_count AS __mcp_count;\nIF @__mcp_count >= 0\nBEGIN\n  IF @__mcp_count > @__mcp_budget SET @__mcp_budget = 0;\n  ELSE SET @__mcp_budget = @__mcp_budget - @__mcp_count;\nEND;\n`;
  });
  const result = await request.batch(batch);
  const resultSets = [];
  let pendingRecordset = null;
  let totalRows = 0;
  let budget = maxRows;
  let truncated = false;
  for (const recordset of result.recordsets ?? []) {
    const marker = recordset?.[0]?.__mcp_marker;
    if (typeof marker === 'string' && marker.startsWith(markerPrefix)) {
      const statementIndex = Number(marker.slice(markerPrefix.length));
      const returnedCount = Number(recordset[0].__mcp_count);
      if (returnedCount < 0) {
        resultSets.push({ statement_index: statementIndex, skipped_due_to_row_limit: true, columns: [], row_count: 0, rows: [] });
      } else {
        const rows = pendingRecordset ?? [];
        const available = Math.max(0, budget);
        const overflow = returnedCount > available;
        const visibleRows = rows.slice(0, available);
        const columns = Object.keys(pendingRecordset?.columns ?? (rows[0] ?? {}));
        resultSets.push({ statement_index: statementIndex, columns, row_count: visibleRows.length, rows: visibleRows, truncated: overflow });
        totalRows += visibleRows.length;
        budget = Math.max(0, budget - visibleRows.length);
        truncated ||= overflow;
      }
      pendingRecordset = null;
    } else {
      pendingRecordset = recordset;
    }
  }
  truncated ||= resultSets.some((set) => set.skipped_due_to_row_limit);
  if (statements.length === 1) {
    const only = resultSets[0] ?? { columns: [], rows: [], truncated: false };
    return resultText({ columns: only.columns, row_count: only.row_count, max_rows: maxRows,
      truncated: Boolean(only.truncated), rows: only.rows });
  }
  return resultText({ statement_count: statements.length, total_row_count: totalRows,
    max_rows: maxRows, truncated, result_sets: resultSets });
});

server.registerTool('kingdee_sqlserver', {
  description: 'Read-only SQL Server and Kingdee Cloud Galaxy queries and metadata. Only SELECT/CTE queries are accepted; write, DDL, procedure execution, deployment and session termination actions are not exposed.',
  inputSchema: {
    action: z.enum(['ping', 'list_databases', 'list_tables', 'describe_table', 'query_sql', 'search_forms', 'form_structure', 'read_bill'])
      .describe('Operation to perform.'),
    schema: z.string().optional().describe('SQL schema for list_tables or describe_table; defaults to dbo.'),
    table: z.string().optional().describe('Table name for describe_table.'),
    query: z.string().optional().describe('One or more semicolon-separated read-only SELECT/CTE statements for query_sql (maximum 50).'),
    parameters: z.record(z.unknown()).optional().describe('SQL parameters, for example {"p1":"ABC"}.'),
    keyword: z.string().optional().describe('Form ID or name keyword for search_forms.'),
    formId: z.string().optional().describe('Kingdee form ID for form_structure or read_bill.'),
    billNumber: z.string().optional().describe('Exact bill number for read_bill; provide this or id.'),
    id: z.string().optional().describe('Internal bill ID for read_bill; provide this or billNumber.'),
    localeId: z.number().int().positive().optional().describe('Kingdee locale ID; defaults to 2052.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum form search results; defaults to 20.'),
    fieldLimit: z.number().int().min(1).max(500).optional().describe('Maximum metadata fields returned; defaults to configured max rows.'),
    entryRowLimit: z.number().int().min(1).max(maxRows).optional().describe('Maximum rows per bill entry table.'),
  },
}, async ({ action, ...args }) => {
  const names = {
    ping: 'sqlserver_ping',
    list_databases: 'sqlserver_list_databases',
    list_tables: 'sqlserver_list_tables',
    describe_table: 'sqlserver_describe_table',
    query_sql: 'sqlserver_query_readonly',
    search_forms: 'kingdee_search_forms',
    form_structure: 'kingdee_get_form_structure',
    read_bill: 'kingdee_read_bill',
  };
  const selected = internalTools.get(names[action]);
  if (!selected) throw new Error(`Unsupported action: ${action}`);
  const parsedArgs = z.object(selected.definition.inputSchema).parse(args);
  return selected.handler(parsedArgs);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.on('SIGINT', async () => {
  await poolPromise?.then((pool) => pool.close());
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await poolPromise?.then((pool) => pool.close());
  process.exit(0);
});

