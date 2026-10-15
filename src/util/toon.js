/** TOON subset: objects, primitive arrays, and uniform tables of primitive cells. */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE_STRING = /^[A-Za-z0-9_. -]+$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

function fail(message) {
  return new Error(`TOON: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assign(target, key, value) {
  if (Object.hasOwn(target, key)) throw fail('duplicate key');
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function encodeKey(key) {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

function encodePrimitive(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('non-finite number');
    return String(value);
  }
  if (typeof value === 'string') {
    const reserved = value === 'true' || value === 'false' || value === 'null';
    // A whitespace-only bare cell is an empty line, which the decoder ignores.
    if (BARE_STRING.test(value) && !reserved && !NUMERIC.test(value) && value.trim() !== '') return value;
    return JSON.stringify(value);
  }
  throw fail('unsupported value');
}

function assertDense(items) {
  for (let i = 0; i < items.length; i++) {
    if (!Object.hasOwn(items, i)) throw fail('sparse array');
  }
}

function isTabular(items) {
  if (!items.every(isPlainObject)) return false;
  const fields = Object.keys(items[0]);
  return items.every((item) => {
    const keys = Object.keys(item);
    if (keys.length !== fields.length) return false;
    return keys.every((key, index) => key === fields[index] && isPrimitiveCell(item[key]));
  });
}

function isPrimitiveCell(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function encodeArray(key, items, indent) {
  assertDense(items);
  if (items.some((item) => isPlainObject(item) && Object.getOwnPropertySymbols(item).length > 0)) {
    throw fail('unsupported value');
  }
  const pad = ' '.repeat(indent);
  const primitive = items.every((item) => (
    item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number'
  ));
  if (items.length === 0 || primitive) {
    const body = items.map((item) => encodePrimitive(item)).join(',');
    return [`${pad}${key}[${items.length}]${body === '' ? ':' : `: ${body}`}`];
  }
  if (!isTabular(items)) throw fail('non-uniform array');
  const fields = Object.keys(items[0]);
  if (fields.length === 0) throw fail('unsupported value');
  const header = `${pad}${key}[${items.length}]{${fields.map(encodeKey).join(',')}}:`;
  const rows = items.map((item) => {
    const cells = fields.map((field) => encodePrimitive(item[field])).join(',');
    return `${pad}  ${cells}`;
  });
  return [header, ...rows];
}

function encodeObject(value, indent) {
  if (Object.getOwnPropertySymbols(value).length > 0) throw fail('unsupported value');
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    const encodedKey = encodeKey(key);
    if (Array.isArray(item)) {
      lines.push(...encodeArray(encodedKey, item, indent));
    } else if (isPlainObject(item)) {
      lines.push(`${pad}${encodedKey}:`);
      lines.push(...encodeObject(item, indent + 2));
    } else {
      lines.push(`${pad}${encodedKey}: ${encodePrimitive(item)}`);
    }
  }
  return lines;
}

export function encodeToon(value) {
  if (!isPlainObject(value)) throw fail('expected a plain object');
  return `${encodeObject(value, 0).join('\n')}\n`;
}

function readJsonString(text, start) {
  if (text[start] !== '"') throw fail('expected string');
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      if (i + 1 >= text.length) throw fail('unterminated string');
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      try {
        return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
      } catch {
        throw fail('invalid string');
      }
    }
    i += 1;
  }
  throw fail('unterminated string');
}

function parseBare(text) {
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (NUMERIC.test(text)) return Number(text);
  return text;
}

function parsePrimitive(text) {
  if (text.startsWith('"')) {
    const { value, end } = readJsonString(text, 0);
    if (end !== text.length) throw fail('trailing data');
    return value;
  }
  return parseBare(text);
}

function parseCells(text) {
  if (text === '') return [];
  const cells = [];
  let i = 0;
  while (i <= text.length) {
    if (i < text.length && text[i] === '"') {
      const { value, end } = readJsonString(text, i);
      cells.push(value);
      i = end;
    } else {
      const comma = text.indexOf(',', i);
      const end = comma === -1 ? text.length : comma;
      cells.push(parseBare(text.slice(i, end)));
      i = end;
    }
    if (i === text.length) break;
    if (text[i] !== ',') throw fail('expected comma');
    i += 1;
    if (i === text.length) cells.push(parseBare(''));
  }
  return cells;
}

function parseFieldList(text) {
  if (text === '') return [];
  const fields = [];
  let i = 0;
  while (i <= text.length) {
    let name;
    if (i < text.length && text[i] === '"') {
      const parsed = readJsonString(text, i);
      if (typeof parsed.value !== 'string') throw fail('bad field');
      name = parsed.value;
      i = parsed.end;
    } else {
      const comma = text.indexOf(',', i);
      const end = comma === -1 ? text.length : comma;
      name = text.slice(i, end);
      i = end;
    }
    if (name === '' || fields.includes(name)) throw fail('bad field');
    fields.push(name);
    if (i === text.length) break;
    if (text[i] !== ',') throw fail('expected comma');
    i += 1;
    if (i === text.length) throw fail('bad field');
  }
  return fields;
}

function findClosingBrace(text) {
  let i = 1;
  while (i < text.length) {
    if (text[i] === '"') {
      i = readJsonString(text, i).end;
      continue;
    }
    if (text[i] === '}') return i;
    i += 1;
  }
  throw fail('unterminated field list');
}

function parseLength(text) {
  if (!/^\d+$/.test(text)) throw fail('bad length');
  const length = Number(text);
  if (!Number.isSafeInteger(length) || String(length) !== text) throw fail('bad length');
  return length;
}

function parseKey(text) {
  if (text.startsWith('"')) {
    const parsed = readJsonString(text, 0);
    if (typeof parsed.value !== 'string') throw fail('bad key');
    return { key: parsed.value, rest: text.slice(parsed.end) };
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
  if (!match) throw fail('bad key');
  return { key: match[0], rest: text.slice(match[0].length) };
}

function parseHeader(text) {
  const { key, rest } = parseKey(text);
  const array = /^\[(\d+)\]/.exec(rest);
  if (array) {
    const length = parseLength(array[1]);
    const after = rest.slice(array[0].length);
    if (after.startsWith('{')) {
      const end = findClosingBrace(after);
      const fields = parseFieldList(after.slice(1, end));
      if (!/^:\s*$/.test(after.slice(end + 1))) throw fail('expected table header');
      return { kind: 'tabular', key, length, fields };
    }
    if (after === ':') {
      if (length !== 0) throw fail('array length mismatch');
      return { kind: 'array', key, cells: [], length };
    }
    if (after.startsWith(': ')) {
      const cells = parseCells(after.slice(2));
      if (cells.length !== length) throw fail('array length mismatch');
      return { kind: 'array', key, cells, length };
    }
    throw fail('expected colon');
  }
  if (rest === ':') return { kind: 'field', key, rawValue: null };
  if (rest.startsWith(': ')) return { kind: 'field', key, rawValue: rest.slice(2) };
  throw fail('expected colon');
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function lineIndent(line) {
  let i = 0;
  while (line[i] === ' ') i += 1;
  if (line[i] === '\t') throw fail('bad indent');
  return i;
}

function nextContent(lines, index, end) {
  let i = index;
  while (i < end && isIgnorable(lines[i])) i += 1;
  return i;
}

function blockEnd(lines, start, minIndent) {
  let i = start;
  while (i < lines.length) {
    if (isIgnorable(lines[i])) {
      i += 1;
      continue;
    }
    if (lineIndent(lines[i]) < minIndent) break;
    i += 1;
  }
  return i;
}

function parseRow(text, fields) {
  const cells = parseCells(text);
  if (cells.length !== fields.length) throw fail('row width mismatch');
  const row = {};
  for (let i = 0; i < fields.length; i++) assign(row, fields[i], cells[i]);
  return row;
}

function parseObject(lines, start, end, indent) {
  const obj = {};
  let i = start;
  while (i < end) {
    if (isIgnorable(lines[i])) {
      i += 1;
      continue;
    }
    if (lineIndent(lines[i]) !== indent) throw fail('unexpected indent');
    const parsed = parseHeader(lines[i].slice(indent));
    if (parsed.kind === 'array') {
      assign(obj, parsed.key, parsed.cells);
      i += 1;
      continue;
    }
    if (parsed.kind === 'tabular') {
      const rows = [];
      let cursor = i + 1;
      const prefix = ' '.repeat(indent + 2);
      for (let r = 0; r < parsed.length; r++) {
        cursor = nextContent(lines, cursor, end);
        if (cursor >= end || !lines[cursor].startsWith(prefix)) throw fail('missing table row');
        rows.push(parseRow(lines[cursor].slice(prefix.length), parsed.fields));
        cursor += 1;
      }
      assign(obj, parsed.key, rows);
      i = cursor;
      continue;
    }
    if (parsed.rawValue === null) {
      const next = nextContent(lines, i + 1, end);
      if (next < end && lineIndent(lines[next]) > indent) {
        if (lineIndent(lines[next]) !== indent + 2) throw fail('unexpected indent');
        const childEnd = blockEnd(lines, next, indent + 2);
        assign(obj, parsed.key, parseObject(lines, next, childEnd, indent + 2));
        i = childEnd;
      } else {
        assign(obj, parsed.key, {});
        i += 1;
      }
      continue;
    }
    const next = nextContent(lines, i + 1, end);
    if (next < end && lineIndent(lines[next]) > indent) throw fail('unexpected indent');
    assign(obj, parsed.key, parsePrimitive(parsed.rawValue));
    i += 1;
  }
  return obj;
}

function decodeToon(text) {
  const lines = text.split(/\r?\n/);
  return parseObject(lines, 0, lines.length, 0);
}

export function decodeDocument(text) {
  if (typeof text !== 'string') throw fail('expected a string');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return decodeToon(trimmed);
}
