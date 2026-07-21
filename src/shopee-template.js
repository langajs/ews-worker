import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const MAX_TEMPLATE_ENTRIES = 100;
const MAX_TEMPLATE_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const TEMPLATE_START_ROW = 7;
const FORBIDDEN_ENTRY_PARTS = ['/vbaproject.', '/externallinks/', '/embeddings/', '/activex/'];
const NUMBER_TOKENS = new Set([
  'ps_category',
  'ps_price',
  'ps_stock',
  'ps_weight',
  'ps_length',
  'ps_width',
  'ps_height',
  'ps_product_pre_order_dts',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  removeNSPrefix: true,
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXml(bytes) {
  return strFromU8(bytes);
}

function normalizeZipPath(basePath, target) {
  const raw = String(target || '').replace(/\\/g, '/');
  if (!raw) return '';
  const parts = (raw.startsWith('/') ? raw.slice(1) : `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}${raw}`).split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function inspectZipArchive(bytes) {
  if (bytes.byteLength < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文件不是有效的 XLSX');
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) throw new Error('模板文件不能超过 5MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('XLSX ZIP 目录不完整');
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (entryCount < 1 || entryCount > MAX_TEMPLATE_ENTRIES) throw new Error('模板内部文件数量异常');
  let offset = centralOffset;
  let uncompressedTotal = 0;
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error('XLSX ZIP 目录损坏');
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/').toLowerCase();
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('模板包含非法文件路径');
    if (FORBIDDEN_ENTRY_PARTS.some(part => `/${name}`.includes(part))) throw new Error('模板包含不允许的宏、外部链接或嵌入对象');
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > MAX_TEMPLATE_UNCOMPRESSED_BYTES) throw new Error('模板解压后体积异常');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function collectText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node !== 'object') return '';
  if (node['#text'] !== undefined) return collectText(node['#text']);
  if (node.t !== undefined) return collectText(node.t);
  if (node.r !== undefined) return collectText(node.r);
  return '';
}

function sharedStrings(files) {
  const bytes = files['xl/sharedStrings.xml'];
  if (!bytes) return [];
  const root = parser.parse(decodeXml(bytes));
  return asArray(root?.sst?.si).map(collectText);
}

function workbookSheets(files) {
  const workbookPath = 'xl/workbook.xml';
  const workbookBytes = files[workbookPath];
  const relsBytes = files['xl/_rels/workbook.xml.rels'];
  if (!workbookBytes || !relsBytes) throw new Error('模板缺少 workbook 定义');
  const workbook = parser.parse(decodeXml(workbookBytes));
  const relationships = parser.parse(decodeXml(relsBytes));
  const targets = new Map(asArray(relationships?.Relationships?.Relationship).map(rel => [String(rel?.['@_Id'] || ''), normalizeZipPath(workbookPath, rel?.['@_Target'])]));
  const sheets = new Map();
  for (const sheet of asArray(workbook?.workbook?.sheets?.sheet)) {
    const name = String(sheet?.['@_name'] || '');
    const path = targets.get(String(sheet?.['@_id'] || '')) || '';
    if (name && path) sheets.set(name, path);
  }
  return sheets;
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function worksheetRows(files, sheetPath, strings) {
  const bytes = files[sheetPath];
  if (!bytes) throw new Error(`模板缺少工作表文件: ${sheetPath}`);
  const root = parser.parse(decodeXml(bytes));
  const rows = new Map();
  for (const row of asArray(root?.worksheet?.sheetData?.row)) {
    const rowNumber = Number(row?.['@_r']);
    if (!Number.isInteger(rowNumber)) continue;
    const values = new Map();
    let fallbackColumn = 0;
    for (const cell of asArray(row?.c)) {
      const index = cell?.['@_r'] ? columnIndex(cell['@_r']) : fallbackColumn;
      fallbackColumn = index + 1;
      const type = String(cell?.['@_t'] || '');
      const raw = cell?.v === undefined ? '' : collectText(cell.v);
      let value = raw;
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = collectText(cell?.is);
      values.set(index, String(value ?? ''));
    }
    rows.set(rowNumber, values);
  }
  return rows;
}

function cell(rows, rowNumber, index) {
  return String(rows.get(rowNumber)?.get(index) || '').trim();
}

function tokenKey(token) {
  return String(token || '').split('|', 1)[0];
}

function parsePriceLimit(text) {
  const matches = String(text || '').match(/(?:VND\s*)?[0-9][0-9,]*(?:\.[0-9]+)?/gi) || [];
  const values = matches.map(value => Number(value.replace(/VND\s*/i, '').replace(/,/g, ''))).filter(value => Number.isFinite(value) && value >= 1000);
  return values.length ? Math.max(...values) : null;
}

function parseDtsRange(value) {
  const match = String(value || '').match(/(\d+)\s*-\s*(\d+)/);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : { min: null, max: null };
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function parseShopeeTemplate(buffer) {
  const bytes = new Uint8Array(buffer);
  inspectZipArchive(bytes);
  let files;
  try {
    files = unzipSync(bytes);
  } catch (_) {
    throw new Error('无法解压 XLSX 模板');
  }
  const sheets = workbookSheets(files);
  const templatePath = sheets.get('Template');
  const categoryPath = sheets.get('Pre-order DTS Range');
  if (!templatePath || !categoryPath) throw new Error('模板缺少 Template 或 Pre-order DTS Range 工作表');
  const strings = sharedStrings(files);
  const templateRows = worksheetRows(files, templatePath, strings);
  const templateType = cell(templateRows, 2, 0).toLowerCase();
  if (templateType !== 'basic') throw new Error('当前仅支持 Shopee Basic Template，请上传店铺基础模板');
  const signature = cell(templateRows, 2, 1);
  const categoryScope = cell(templateRows, 2, 2);
  const contextId = cell(templateRows, 2, 3);
  if (!signature || !contextId) throw new Error('模板缺少店铺上下文标识，请重新从 Seller Centre 下载');

  const tokenRow = templateRows.get(1) || new Map();
  const maxColumn = Math.max(...tokenRow.keys(), -1);
  if (maxColumn < 10) throw new Error('模板字段数量异常');
  const fields = [];
  const seenTokens = new Set();
  for (let index = 0; index <= maxColumn; index++) {
    const token = cell(templateRows, 1, index);
    if (!token) continue;
    if (seenTokens.has(token)) throw new Error(`模板隐藏字段重复: ${token}`);
    seenTokens.add(token);
    fields.push({
      token,
      key: tokenKey(token),
      column: index,
      column_name: columnName(index),
      label: cell(templateRows, 3, index),
      requirement: cell(templateRows, 4, index),
      description: cell(templateRows, 5, index),
      rule: cell(templateRows, 6, index),
    });
  }
  const requiredKeys = ['ps_product_name', 'ps_product_description', 'ps_price', 'ps_weight'];
  for (const key of requiredKeys) {
    if (!fields.some(field => field.key === key)) throw new Error(`模板缺少必要字段: ${key}`);
  }
  const shippingChannels = fields.filter(field => /^channel_id\.\d+$/.test(field.key)).map(field => ({
    id: field.key.slice('channel_id.'.length),
    label: field.label || field.key,
    price_limit: parsePriceLimit(`${field.description} ${field.rule}`),
    supports_preorder: field.key !== 'channel_id.5012',
  }));
  if (!shippingChannels.length) throw new Error('模板未包含可用物流渠道');

  const categoryRows = worksheetRows(files, categoryPath, strings);
  const categories = [];
  const categoryIds = new Set();
  for (const [rowNumber, values] of categoryRows) {
    if (rowNumber < 2) continue;
    const id = String(values.get(1) || '').trim();
    if (!/^\d+$/.test(id) || categoryIds.has(id)) continue;
    categoryIds.add(id);
    const sourceName = String(values.get(0) || '').trim();
    const name = sourceName.replace(new RegExp(`^${id}-?`), '').trim() || sourceName;
    const dtsRange = String(values.get(2) || '').trim();
    const parsedRange = parseDtsRange(dtsRange);
    categories.push({ id, name, dts_range: dtsRange, dts_min: parsedRange.min, dts_max: parsedRange.max });
  }
  if (!categories.length) throw new Error('模板分类目录为空');

  return {
    manifest: {
      format_version: 1,
      template_type: templateType,
      signature,
      category_scope: categoryScope,
      context_id: contextId,
      sheet_path: templatePath,
      start_row: TEMPLATE_START_ROW,
      field_count: fields.length,
      fields,
      shipping_channels: shippingChannels,
      category_count: categories.length,
    },
    categories,
  };
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function cellXml(column, rowNumber, key, value) {
  if (value === undefined || value === null || value === '') return '';
  const reference = `${column}${rowNumber}`;
  if (NUMBER_TOKENS.has(key) && Number.isFinite(Number(value))) return `<c r="${reference}"><v>${Number(value)}</v></c>`;
  const text = escapeXml(value);
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function injectRows(sheetXml, manifest, rows) {
  const sheetDataMatch = sheetXml.match(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/);
  if (!sheetDataMatch) throw new Error('模板 Template 工作表缺少 sheetData');
  const opening = sheetDataMatch[0].match(/^<sheetData\b[^>]*>/)?.[0] || '<sheetData>';
  const existingBody = sheetDataMatch[0].slice(opening.length, -'</sheetData>'.length);
  const preservedRows = [];
  const rowPattern = /<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
  for (const match of existingBody.matchAll(rowPattern)) {
    const rowNumber = Number(match[0].match(/\br="(\d+)"/)?.[1]);
    if (Number.isInteger(rowNumber) && rowNumber < manifest.start_row) preservedRows.push(match[0]);
  }
  const dataRows = rows.map((values, rowIndex) => {
    const rowNumber = manifest.start_row + rowIndex;
    const cells = manifest.fields.map(field => cellXml(field.column_name, rowNumber, field.key, values[field.key])).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  let updated = sheetXml.replace(sheetDataMatch[0], `${opening}${preservedRows.join('')}${dataRows}</sheetData>`);
  const lastColumn = manifest.fields.reduce((max, field) => Math.max(max, field.column), 0);
  const lastRow = Math.max(manifest.start_row - 1, manifest.start_row + rows.length - 1);
  updated = updated.replace(/<dimension\b[^>]*\bref="[^"]*"[^>]*(?:\/>|><\/dimension>)/, match => match.replace(/\bref="[^"]*"/, `ref="A1:${columnName(lastColumn)}${lastRow}"`));
  return updated;
}

export function buildShopeeWorkbook(buffer, manifest, rows) {
  const bytes = new Uint8Array(buffer);
  inspectZipArchive(bytes);
  const files = unzipSync(bytes);
  const sheetPath = String(manifest?.sheet_path || '');
  if (!sheetPath || !files[sheetPath]) throw new Error('模板工作表路径无效');
  const sheetXml = decodeXml(files[sheetPath]);
  files[sheetPath] = strToU8(injectRows(sheetXml, manifest, rows));
  return zipSync(files, { level: 6 });
}
