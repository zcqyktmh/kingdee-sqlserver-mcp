const MAX_QUERY_LENGTH = 50000;
const MAX_STATEMENTS = 50;

export function splitReadOnlyStatements(query) {
  if (typeof query !== 'string') throw new Error('SQL must be a string.');
  if (query.length > MAX_QUERY_LENGTH) throw new Error('Query is too long (maximum 50,000 characters).');

  const statements = [];
  let start = 0;
  let state = 'normal';
  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    const next = query[i + 1];
    if (state === 'single') {
      if (char === "'" && next === "'") i += 1;
      else if (char === "'") state = 'normal';
      continue;
    }
    if (state === 'bracket') {
      if (char === ']' && next === ']') i += 1;
      else if (char === ']') state = 'normal';
      continue;
    }
    if (state === 'double') {
      if (char === '"' && next === '"') i += 1;
      else if (char === '"') state = 'normal';
      continue;
    }

    if (char === '-' && next === '-' || char === '/' && next === '*') {
      throw new Error('SQL comments are not allowed in read-only queries.');
    }
    if (char === "'") state = 'single';
    else if (char === '[') state = 'bracket';
    else if (char === '"') state = 'double';
    else if (char === ';') {
      const statement = query.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  if (state !== 'normal') throw new Error('SQL contains an unterminated string or quoted identifier.');
  const last = query.slice(start).trim();
  if (last) statements.push(last);
  if (!statements.length) throw new Error('SQL 不能为空');
  if (statements.length > MAX_STATEMENTS) {
    throw new Error(`At most ${MAX_STATEMENTS} read-only SQL statements are allowed per call.`);
  }
  return statements;
}

export function validateReadOnlyQuery(statement) {
  const code = statement
    .replace(/N?'(?:''|[^'])*'/gi, ' ')
    .replace(/\[(?:[^\]]|\]\])*\]/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ')
    .trim();
  if (!/^(SELECT|WITH)\b/i.test(code)) throw new Error('Only SELECT queries and read-only CTEs are allowed.');
  const forbidden = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC(?:UTE)?|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|BULK|OPENROWSET|OPENQUERY|OPENDATASOURCE|INTO|KILL|SHUTDOWN|RECONFIGURE|WAITFOR)\b/i;
  if (forbidden.test(code)) throw new Error('Query contains a disallowed write, administrative, or external-access keyword.');
  if (/\b(?:sys\.)?(?:xp_|sp_)[a-z0-9_]*\b|\bNEXT\s+VALUE\s+FOR\b/i.test(code)) {
    throw new Error('System procedures and sequence advancement are not allowed.');
  }
  if (/\bSELECT\s+(?:DISTINCT\s+)?@[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)/i.test(code)) {
    throw new Error('Variable assignment is not allowed in read-only queries.');
  }
  return true;
}

