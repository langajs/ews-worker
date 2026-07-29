import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { isShopeePreOrderShippingChannel } from './shopee-preorder.js';

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const MAX_TEMPLATE_ENTRIES = 100;
const MAX_TEMPLATE_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
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
const TOKEN_SEMANTICS = new Set([
  'ps_category', 'ps_product_name', 'ps_product_description', 'ps_sku_parent_short',
  'et_title_variation_integration_no', 'et_title_variation_1', 'et_title_option_for_variation_1',
  'et_title_image_per_variation', 'et_title_variation_2', 'et_title_option_for_variation_2',
  'ps_price', 'ps_stock', 'ps_sku_short', 'ps_new_size_chart', 'et_title_size_chart', 'ps_gtin_code',
  'ps_item_cover_image', 'ps_item_image_1', 'ps_item_image_2', 'ps_item_image_3', 'ps_item_image_4',
  'ps_item_image_5', 'ps_item_image_6', 'ps_item_image_7', 'ps_item_image_8',
  'ps_weight', 'ps_length', 'ps_width', 'ps_height', 'ps_product_pre_order_dts', 'ps_brand', 'et_title_reason',
]);
const CORE_TEMPLATE_TOKENS = ['ps_product_name', 'ps_price', 'ps_weight'];
const REQUIRED_TEMPLATE_TOKENS = ['ps_product_name', 'ps_product_description', 'ps_price', 'ps_weight'];
const SENSITIVE_SHEET_NAMES = new Set(['hiddenshopbrand', 'hiddentax']);
const GLOBAL_ATTRIBUTE_TOKEN = /^ps_product_global_attribute\.(\d+)$/;

export const SHOPEE_TEMPLATE_SEMANTIC_KEYS = Object.freeze([...TOKEN_SEMANTICS].sort());

export function shopeeParentSku(parentSku, subTaskId, setIndex, mode = 'numbered') {
  const customSku = String(parentSku || '').trim();
  if (customSku) return mode === 'repeat' ? customSku : `${customSku}-${Number(setIndex) + 1}`;
  return String(subTaskId || '').slice(0, 8);
}

export function shopeeVariationIntegrationNo(subTaskId, isSingleProduct = false) {
  return isSingleProduct ? '' : String(subTaskId || '').slice(0, 8);
}

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
  const sheets = [];
  for (const sheet of asArray(workbook?.workbook?.sheets?.sheet)) {
    const name = String(sheet?.['@_name'] || '');
    const path = targets.get(String(sheet?.['@_id'] || '')) || '';
    if (name && path) sheets.push({ name, path, state: String(sheet?.['@_state'] || 'visible') });
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

function tokenDefinition(token) {
  const key = tokenKey(token);
  const channel = /^channel_id\.(\d+)$/.exec(key);
  const attribute = GLOBAL_ATTRIBUTE_TOKEN.exec(key);
  const semanticKey = TOKEN_SEMANTICS.has(key) || channel || attribute ? key : '';
  return {
    key,
    semantic_key: semanticKey,
    data_type: NUMBER_TOKENS.has(semanticKey) ? 'number' : 'string',
    token_family: channel ? 'shipping_channel' : (attribute ? 'product_global_attribute' : 'fixed'),
    attribute_id: attribute?.[1] || '',
  };
}

function requirementType(value) {
  const requirement = String(value || '').trim();
  if (/conditional|có điều kiện/i.test(requirement)) return 'conditional';
  if (/mandatory|required|bắt buộc/i.test(requirement)) return 'required';
  return 'optional';
}

function countPopulatedColumns(rows, rowNumber, columns) {
  return columns.reduce((count, index) => count + (cell(rows, rowNumber, index) ? 1 : 0), 0);
}

function locateProductSheet(sheets, rowsForSheet) {
  const candidates = [];
  for (const sheet of sheets) {
    const rows = rowsForSheet(sheet);
    for (const [rowNumber, values] of rows) {
      const keys = new Set([...values.values()].map(tokenKey).filter(Boolean));
      if (!CORE_TEMPLATE_TOKENS.every(key => keys.has(key))) continue;
      const tokenCount = [...keys].filter(key => key.startsWith('ps_') || key.startsWith('et_title_') || key.startsWith('channel_id.')).length;
      const hasStoreContext = [...rows.keys()].some(candidateRow =>
        candidateRow !== rowNumber && Math.abs(candidateRow - rowNumber) <= 12
        && ['basic', 'advanced'].includes(cell(rows, candidateRow, 0).toLowerCase())
        && cell(rows, candidateRow, 1) && cell(rows, candidateRow, 3));
      candidates.push({ sheet, rows, token_row: rowNumber, score: tokenCount + (hasStoreContext ? 1000 : 0) });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  if (!candidates.length) throw new Error('模板缺少 Shopee 官方隐藏 token，无法识别商品工作表');
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) throw new Error('模板包含多个无法区分的商品工作表');
  return candidates[0];
}

function locateMetadataRow(rows, tokenRow) {
  const candidates = [...rows.keys()].filter(rowNumber => rowNumber !== tokenRow && Math.abs(rowNumber - tokenRow) <= 12);
  for (const rowNumber of candidates.sort((left, right) => Math.abs(left - tokenRow) - Math.abs(right - tokenRow))) {
    const templateType = cell(rows, rowNumber, 0).toLowerCase();
    if (templateType && cell(rows, rowNumber, 1) && cell(rows, rowNumber, 3)) return rowNumber;
  }
  throw new Error('模板缺少店铺上下文元数据，请重新从 Seller Centre 下载');
}

function inferLayoutRows(rows, tokenRow, metadataRow, columns) {
  const nearby = [...rows.keys()].filter(rowNumber => rowNumber > tokenRow && rowNumber <= tokenRow + 16 && rowNumber !== metadataRow);
  const requirementCandidates = nearby.map(rowNumber => ({
    row: rowNumber,
    score: columns.reduce((count, index) => count + (/mandatory|optional|required|bắt buộc/i.test(cell(rows, rowNumber, index)) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score);
  const requirementRow = requirementCandidates[0]?.score >= 2 ? requirementCandidates[0].row : null;
  if (!requirementRow) throw new Error('模板缺少字段必填规则行，工作簿结构可能已被修改');
  const labelCandidates = nearby.filter(rowNumber => rowNumber < requirementRow).map(rowNumber => ({
    row: rowNumber,
    score: countPopulatedColumns(rows, rowNumber, columns),
  })).sort((left, right) => right.score - left.score);
  const labelRow = labelCandidates[0]?.score ? labelCandidates[0].row : null;
  if (!labelRow) throw new Error('模板缺少字段表头行，工作簿结构可能已被修改');
  return {
    label_row: labelRow,
    requirement_row: requirementRow,
    description_row: requirementRow + 1,
    rule_row: requirementRow + 2,
    start_row: requirementRow + 3,
  };
}

function locateCategorySheet(sheets, rowsForSheet, productPath) {
  const candidates = [];
  for (const sheet of sheets) {
    if (sheet.path === productPath || SENSITIVE_SHEET_NAMES.has(sheet.name.toLowerCase())) continue;
    const rows = rowsForSheet(sheet);
    for (const values of rows.values()) {
      const tokenColumns = new Map([...values.entries()].map(([index, value]) => [tokenKey(value), index]));
      if (!tokenColumns.has('et_title_category_name') || !tokenColumns.has('et_title_category_id')) continue;
      candidates.push({
        sheet,
        rows,
        id_column: tokenColumns.get('et_title_category_id'),
        name_column: tokenColumns.get('et_title_category_name'),
        dts_column: tokenColumns.get('et_title_dts_range') ?? null,
        score: 100000,
      });
    }
    const columns = new Set();
    for (const values of rows.values()) for (const index of values.keys()) columns.add(index);
    for (const idColumn of columns) {
      const matchingRows = [...rows.entries()].filter(([, values]) => /^\d+$/.test(String(values.get(idColumn) || '').trim()));
      const uniqueIds = new Set(matchingRows.map(([, values]) => String(values.get(idColumn)).trim()));
      if (uniqueIds.size < 10) continue;
      const otherColumns = [...columns].filter(index => index !== idColumn);
      const nameColumn = otherColumns.map(index => ({
        index,
        score: matchingRows.reduce((count, [, values]) => count + (/\D/.test(String(values.get(index) || '')) ? 1 : 0), 0),
      })).sort((left, right) => right.score - left.score)[0];
      if (!nameColumn || nameColumn.score < Math.min(10, uniqueIds.size)) continue;
      const dtsColumn = otherColumns.map(index => ({
        index,
        score: matchingRows.reduce((count, [, values]) => count + (/\d+\s*-\s*\d+/.test(String(values.get(index) || '')) ? 1 : 0), 0),
      })).sort((left, right) => right.score - left.score)[0];
      candidates.push({ sheet, rows, id_column: idColumn, name_column: nameColumn.index, dts_column: dtsColumn?.score ? dtsColumn.index : null, score: uniqueIds.size });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  if (!candidates.length) throw new Error('模板缺少可识别的 Category ID / DTS 工作表');
  return candidates[0];
}

function sensitiveSheetSummary(sheets, rowsForSheet) {
  const summary = [];
  for (const sheet of sheets) {
    if (!SENSITIVE_SHEET_NAMES.has(sheet.name.toLowerCase())) continue;
    const nonemptyCells = [...rowsForSheet(sheet).values()].reduce((total, values) =>
      total + [...values.values()].filter(value => String(value || '').trim()).length, 0);
    if (nonemptyCells) summary.push({ name: sheet.name, nonempty_cells: nonemptyCells });
  }
  return summary;
}

function workbookValueSource(sheets, rowsForSheet) {
  return JSON.stringify(sheets.map(sheet => [
    sheet.name,
    sheet.state,
    [...rowsForSheet(sheet).entries()].sort((left, right) => left[0] - right[0]).map(([rowNumber, values]) => [
      rowNumber,
      [...values.entries()].sort((left, right) => left[0] - right[0]),
    ]),
  ]));
}

function categoryRequiredFields(sheets, rowsForSheet, fields) {
  const sheet = sheets.find(candidate => candidate.name.toLowerCase() === 'hiddencatprops');
  if (!sheet) return {};
  const conditionalFields = fields.filter(field => field.requirement_type === 'conditional');
  if (!conditionalFields.length) return {};
  const requirements = {};
  for (const values of rowsForSheet(sheet).values()) {
    const categoryMatch = String(values.get(0) || '').trim().match(/^(\d+)(?:-|$)/);
    if (!categoryMatch) continue;
    const required = conditionalFields
      .filter(field => String(values.get(field.column) || '').trim().toUpperCase() === 'MANDATORY')
      .map(field => field.key);
    if (required.length) requirements[categoryMatch[1]] = required;
  }
  return requirements;
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

function comparableFields(manifest) {
  return (manifest?.fields || []).map(field => [
    field.token || '', field.key || '', Number(field.column || 0), field.label || '',
    field.requirement || '', field.description || '', field.rule || '',
  ]).sort((left, right) => left[2] - right[2] || left[0].localeCompare(right[0]));
}

function comparableChannels(manifest) {
  return (manifest?.shipping_channels || []).map(channel => [
    String(channel.id || ''), channel.label || '', channel.price_limit ?? null, channel.supports_preorder !== false,
  ]).sort((left, right) => left[0].localeCompare(right[0]));
}

function channelSupportsPreOrder(field) {
  return isShopeePreOrderShippingChannel(field);
}

function comparableCategories(categories) {
  return (categories || []).map(category => [
    String(category.id || ''), category.name || '', category.dts_range || '', category.dts_min ?? null, category.dts_max ?? null,
  ]).sort((left, right) => left[0].localeCompare(right[0]));
}

function comparableCategoryRequirements(manifest) {
  return Object.entries(manifest?.category_required_fields || {}).map(([categoryId, tokens]) => [
    String(categoryId), [...new Set(tokens || [])].sort(),
  ]).sort((left, right) => left[0].localeCompare(right[0]));
}

function compareKeyedRows(beforeRows, afterRows) {
  const before = new Map(beforeRows.map(row => [row[0], JSON.stringify(row.slice(1))]));
  const after = new Map(afterRows.map(row => [row[0], JSON.stringify(row.slice(1))]));
  const added = [...after.keys()].filter(key => !before.has(key)).sort();
  const removed = [...before.keys()].filter(key => !after.has(key)).sort();
  const changed = [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)).sort();
  return { before_count: before.size, after_count: after.size, added, removed, changed };
}

export function compareShopeeTemplateSemantics(beforeManifest, beforeCategories, afterManifest, afterCategories) {
  const fields = compareKeyedRows(comparableFields(beforeManifest), comparableFields(afterManifest));
  const channels = compareKeyedRows(comparableChannels(beforeManifest), comparableChannels(afterManifest));
  const categories = compareKeyedRows(comparableCategories(beforeCategories), comparableCategories(afterCategories));
  const beforeRequirements = JSON.stringify(comparableCategoryRequirements(beforeManifest));
  const afterRequirements = JSON.stringify(comparableCategoryRequirements(afterManifest));
  const signatureChanged = String(beforeManifest?.signature || '') !== String(afterManifest?.signature || '');
  const hasChanges = signatureChanged
    || [fields, channels, categories].some(group => group.added.length || group.removed.length || group.changed.length)
    || beforeRequirements !== afterRequirements;
  return {
    has_changes: hasChanges,
    signature_changed: signatureChanged,
    category_requirements_changed: beforeRequirements !== afterRequirements,
    fields,
    shipping_channels: channels,
    categories,
  };
}

export function parseShopeeTemplate(buffer, { allowAdvanced = false } = {}) {
  const bytes = new Uint8Array(buffer);
  inspectZipArchive(bytes);
  let files;
  try {
    files = unzipSync(bytes);
  } catch (_) {
    throw new Error('无法解压 XLSX 模板');
  }
  const strings = sharedStrings(files);
  const sheets = workbookSheets(files);
  const rowsCache = new Map();
  const rowsForSheet = sheet => {
    if (!rowsCache.has(sheet.path)) rowsCache.set(sheet.path, worksheetRows(files, sheet.path, strings));
    return rowsCache.get(sheet.path);
  };
  const productSheet = locateProductSheet(sheets, rowsForSheet);
  const templateRows = productSheet.rows;
  const tokenRowNumber = productSheet.token_row;
  const metadataRow = locateMetadataRow(templateRows, tokenRowNumber);
  const templateType = cell(templateRows, metadataRow, 0).toLowerCase();
  if (templateType !== 'basic' && !(allowAdvanced && templateType === 'advanced')) {
    throw new Error('当前仅支持 Shopee Basic Template，请上传店铺基础模板');
  }
  const signature = cell(templateRows, metadataRow, 1);
  const categoryScope = cell(templateRows, metadataRow, 2);
  const contextId = cell(templateRows, metadataRow, 3);
  if (!signature || !contextId) throw new Error('模板缺少店铺上下文标识，请重新从 Seller Centre 下载');

  const tokenRow = templateRows.get(tokenRowNumber) || new Map();
  const maxColumn = Math.max(...tokenRow.keys(), -1);
  if (maxColumn < 10) throw new Error('模板字段数量异常');
  const tokenColumns = [...tokenRow.keys()].filter(index => cell(templateRows, tokenRowNumber, index));
  const layout = inferLayoutRows(templateRows, tokenRowNumber, metadataRow, tokenColumns);
  const fields = [];
  const seenTokens = new Set();
  for (let index = 0; index <= maxColumn; index++) {
    const token = cell(templateRows, tokenRowNumber, index);
    if (!token) continue;
    if (seenTokens.has(token)) throw new Error(`模板隐藏字段重复: ${token}`);
    seenTokens.add(token);
    const definition = tokenDefinition(token);
    const requirement = cell(templateRows, layout.requirement_row, index);
    const requirementKind = requirementType(requirement);
    const requiresMapping = requirementKind !== 'optional';
    fields.push({
      token,
      key: definition.key,
      semantic_key: definition.semantic_key,
      data_type: definition.data_type,
      token_family: definition.token_family,
      attribute_id: definition.attribute_id,
      mapping_status: definition.semantic_key ? 'mapped' : (requiresMapping ? 'unmapped_required' : 'unmapped_optional'),
      is_required: requirementKind === 'required',
      requirement_type: requirementKind,
      column: index,
      column_name: columnName(index),
      label: cell(templateRows, layout.label_row, index),
      requirement,
      description: cell(templateRows, layout.description_row, index),
      rule: cell(templateRows, layout.rule_row, index),
    });
  }
  for (const key of REQUIRED_TEMPLATE_TOKENS) {
    if (!fields.some(field => field.key === key)) throw new Error(`模板缺少必要字段: ${key}`);
  }
  const shippingChannels = fields.filter(field => /^channel_id\.\d+$/.test(field.semantic_key)).map(field => ({
    id: field.semantic_key.slice('channel_id.'.length),
    label: field.label || field.key,
    price_limit: parsePriceLimit(`${field.description} ${field.rule}`),
    supports_preorder: channelSupportsPreOrder(field),
  }));
  if (!shippingChannels.length) throw new Error('模板未包含可用物流渠道');

  const categorySheet = locateCategorySheet(sheets, rowsForSheet, productSheet.sheet.path);
  const categories = [];
  const categoryIds = new Set();
  for (const values of categorySheet.rows.values()) {
    const id = String(values.get(categorySheet.id_column) || '').trim();
    if (!/^\d+$/.test(id) || categoryIds.has(id)) continue;
    categoryIds.add(id);
    const sourceName = String(values.get(categorySheet.name_column) || '').trim();
    const name = sourceName.replace(new RegExp(`^${id}-?`), '').trim() || sourceName;
    const dtsRange = categorySheet.dts_column === null ? '' : String(values.get(categorySheet.dts_column) || '').trim();
    const parsedRange = parseDtsRange(dtsRange);
    categories.push({ id, name, dts_range: dtsRange, dts_min: parsedRange.min, dts_max: parsedRange.max });
  }
  if (!categories.length) throw new Error('模板分类目录为空');
  const sensitiveSheets = sensitiveSheetSummary(sheets, rowsForSheet);
  const categoryRequirements = categoryRequiredFields(sheets, rowsForSheet, fields);
  const unknownRequiredTokens = fields.filter(field => field.mapping_status === 'unmapped_required').map(field => field.token);
  const unknownOptionalTokens = fields.filter(field => field.mapping_status === 'unmapped_optional').map(field => field.token);
  const dynamicTokens = fields.filter(field => field.token_family !== 'fixed').map(field => field.token);

  return {
    manifest: {
      format_version: 3,
      token_registry_version: 2,
      template_fingerprint_version: 2,
      template_type: templateType,
      signature,
      category_scope: categoryScope,
      store_context_id: contextId,
      context_id: contextId,
      sheet_name: productSheet.sheet.name,
      sheet_path: productSheet.sheet.path,
      token_row: tokenRowNumber,
      metadata_row: metadataRow,
      label_row: layout.label_row,
      requirement_row: layout.requirement_row,
      start_row: layout.start_row,
      field_count: fields.length,
      fields,
      shipping_channels: shippingChannels,
      category_count: categories.length,
      category_sheet_name: categorySheet.sheet.name,
      category_sheet_path: categorySheet.sheet.path,
      unknown_required_tokens: unknownRequiredTokens,
      unknown_optional_tokens: unknownOptionalTokens,
      recognized_dynamic_tokens: dynamicTokens,
      category_required_fields: categoryRequirements,
      sensitive_sheets: sensitiveSheets,
    },
    schema_source: JSON.stringify({
      template_type: templateType,
      token_row: tokenRowNumber,
      start_row: layout.start_row,
      fields: fields.map(field => [field.token, field.column, field.requirement]),
    }),
    comparison_source: workbookValueSource(sheets, rowsForSheet),
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
    const cells = manifest.fields.map(field => {
      const semanticKey = field.semantic_key || field.key;
      return cellXml(field.column_name, rowNumber, semanticKey, values[semanticKey]);
    }).join('');
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
