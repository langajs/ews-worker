import assert from 'node:assert/strict';
import test from 'node:test';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  buildShopeeWorkbook,
  shopeeParentSku,
  shopeeVariationIntegrationNo,
} from '../src/shopee-template.js';

test('keeps custom Parent SKU separate from the sub-task integration number', () => {
  assert.equal(shopeeParentSku('SHOP-PARENT', 'subT1234-full-id', 0, 'repeat'), 'SHOP-PARENT');
  assert.equal(shopeeParentSku('SHOP-PARENT', 'subT5678-full-id', 1, 'repeat'), 'SHOP-PARENT');
  assert.equal(shopeeParentSku('SHOP-PARENT', 'subT1234-full-id', 0, 'numbered'), 'SHOP-PARENT-1');
  assert.equal(shopeeParentSku('SHOP-PARENT', 'subT5678-full-id', 1, 'numbered'), 'SHOP-PARENT-2');
  assert.equal(shopeeParentSku('', 'subT1234-full-id', 0), 'subT1234');
  assert.equal(shopeeParentSku('', 'subT1234-full-id', 0, 'repeat'), 'subT1234');
  assert.equal(shopeeVariationIntegrationNo('subT1234-full-id'), 'subT1234');
  assert.equal(shopeeVariationIntegrationNo('subT1234-full-id', true), '');
});

test('writes custom Parent SKU and sub-task integration number to separate columns', () => {
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sourceXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<dimension ref="A1:B7"/><sheetData><row r="1"/></sheetData></worksheet>';
  const source = zipSync({ [sheetPath]: strToU8(sourceXml) });
  const manifest = {
    sheet_path: sheetPath,
    start_row: 7,
    fields: [
      { column: 0, column_name: 'A', key: 'ps_sku_parent_short', semantic_key: 'ps_sku_parent_short' },
      { column: 1, column_name: 'B', key: 'et_title_variation_integration_no', semantic_key: 'et_title_variation_integration_no' },
    ],
  };
  const subTaskId = 'subT1234-full-id';
  const output = buildShopeeWorkbook(source, manifest, [{
    ps_sku_parent_short: shopeeParentSku('SHOP-PARENT', subTaskId, 0, 'repeat'),
    et_title_variation_integration_no: shopeeVariationIntegrationNo(subTaskId),
  }]);
  const xml = strFromU8(unzipSync(output)[sheetPath]);

  assert.match(xml, /<c r="A7" t="inlineStr"><is><t xml:space="preserve">SHOP-PARENT<\/t><\/is><\/c>/);
  assert.match(xml, /<c r="B7" t="inlineStr"><is><t xml:space="preserve">subT1234<\/t><\/is><\/c>/);
});

test('writes pre-order DTS and shipping values through the template manifest', () => {
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sourceXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<dimension ref="A1:E8"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>tokens</t></is></c></row>'
    + '<row r="7"><c r="C7"><v>2</v></c></row><row r="8"><c r="C8"><v>2</v></c></row></sheetData></worksheet>';
  const source = zipSync({ [sheetPath]: strToU8(sourceXml) });
  const manifest = {
    sheet_path: sheetPath,
    start_row: 7,
    fields: [
      { column: 0, column_name: 'A', key: 'ps_product_name', semantic_key: 'ps_product_name' },
      { column: 2, column_name: 'C', key: 'ps_product_pre_order_dts', semantic_key: 'ps_product_pre_order_dts' },
      { column: 3, column_name: 'D', key: 'channel_id.50052', semantic_key: 'channel_id.50052' },
      { column: 4, column_name: 'E', key: 'channel_id.5012', semantic_key: 'channel_id.5012' },
    ],
  };

  const output = buildShopeeWorkbook(source, manifest, [{
    ps_product_name: 'Audit product',
    ps_product_pre_order_dts: 15,
    'channel_id.50052': 'On',
    'channel_id.5012': 'Off',
  }]);
  const xml = strFromU8(unzipSync(output)[sheetPath]);

  assert.match(xml, /<c r="C7"><v>15<\/v><\/c>/);
  assert.match(xml, /<c r="D7" t="inlineStr"><is><t xml:space="preserve">On<\/t><\/is><\/c>/);
  assert.match(xml, /<c r="E7" t="inlineStr"><is><t xml:space="preserve">Off<\/t><\/is><\/c>/);
  assert.doesNotMatch(xml, /<row r="8">/);
});
