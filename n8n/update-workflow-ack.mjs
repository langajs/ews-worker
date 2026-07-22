import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
const responseBody = "={{ { success: true, status: 'accepted', plan_id: $json.body.plan_id || '' } }}";
let updated = 0;

for (const file of files) {
  const filename = path.join(directory, file);
  const source = await readFile(filename, 'utf8');
  const parsed = JSON.parse(source);
  const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
  const node = workflow?.nodes?.find(item => item.type === 'n8n-nodes-base.respondToWebhook'
    && item.parameters?.options?.responseCode === 202);
  if (!node) continue;
  const currentBody = String(node.parameters.responseBody || '');
  if (currentBody !== responseBody) {
    const currentToken = `"responseBody": ${JSON.stringify(currentBody)}`;
    if (!source.includes(currentToken)) throw new Error(`${file} ACK source token not found`);
    await writeFile(filename, source.replace(currentToken, `"responseBody": ${JSON.stringify(responseBody)}`), 'utf8');
  }
  updated++;
}

if (updated !== 9) throw new Error(`Expected 9 workflow ACK nodes, updated ${updated}`);
console.log(`Updated ${updated} workflow ACK nodes`);
