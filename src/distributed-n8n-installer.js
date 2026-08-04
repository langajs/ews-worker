import INSTALLER_TEMPLATE from '../n8n/deploy/install-ews-node.ps1';
import CMD_TEMPLATE from '../n8n/deploy/install-ews-node.cmd';
import sidecarDockerfile from '../n8n/image-sidecar/Dockerfile';
import sidecarPackage from '../n8n/image-sidecar/package.json';
import sidecarPackageLock from '../n8n/image-sidecar/package-lock.json';
import sidecarApp from '../n8n/image-sidecar/src/app.js';
import sidecarConfig from '../n8n/image-sidecar/src/config.js';
import sidecarErrors from '../n8n/image-sidecar/src/errors.js';
import sidecarImage from '../n8n/image-sidecar/src/image.js';
import sidecarPipeline from '../n8n/image-sidecar/src/pipeline.js';
import sidecarQueue from '../n8n/image-sidecar/src/queue.js';
import sidecarSecurity from '../n8n/image-sidecar/src/security.js';
import sidecarServer from '../n8n/image-sidecar/src/server.js';
import sidecarWorkerApi from '../n8n/image-sidecar/src/worker-api.js';
import sidecarWorker from '../n8n/image-sidecar/src/worker.js';

const IMAGE_SIDECAR_PLACEHOLDER = '__EWS_IMAGE_SIDECAR_BUNDLE_B64__';
const PAYLOAD_PLACEHOLDER = '__EWS_POWERSHELL_PAYLOAD__';
const PS1_BEGIN_MARKER = '__EWS_PS1_BEGIN__';
const PS1_END_MARKER = '__EWS_PS1_END__';

function sidecarEntry(name, content) {
  if (!name || typeof content !== 'string' || !content.trim()) {
    throw new Error(`Invalid image sidecar source: ${name}`);
  }
  return { name, content };
}

const IMAGE_SIDECAR_FILES = Object.freeze([
  sidecarEntry('Dockerfile', sidecarDockerfile),
  sidecarEntry('package.json', sidecarPackage),
  sidecarEntry('package-lock.json', sidecarPackageLock),
  sidecarEntry('src/app.js', sidecarApp),
  sidecarEntry('src/config.js', sidecarConfig),
  sidecarEntry('src/errors.js', sidecarErrors),
  sidecarEntry('src/image.js', sidecarImage),
  sidecarEntry('src/pipeline.js', sidecarPipeline),
  sidecarEntry('src/queue.js', sidecarQueue),
  sidecarEntry('src/security.js', sidecarSecurity),
  sidecarEntry('src/server.js', sidecarServer),
  sidecarEntry('src/worker-api.js', sidecarWorkerApi),
  sidecarEntry('src/worker.js', sidecarWorker),
]);

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bundleAssignmentLines(variable, value) {
  const chunks = value.match(/.{1,4000}/g) || [''];
  return [
    `$${variable} = ''`,
    ...chunks.map(chunk => `$${variable} += '${chunk}'`),
  ].join('\r\n');
}

export function getDistributedN8nInstallerScript() {
  if (!INSTALLER_TEMPLATE.includes(IMAGE_SIDECAR_PLACEHOLDER)) {
    throw new Error('Distributed n8n installer image sidecar placeholder is missing');
  }
  if (!CMD_TEMPLATE.includes(PAYLOAD_PLACEHOLDER)) {
    throw new Error('Distributed n8n CMD payload placeholder is missing');
  }
  const imageSidecarBundle = utf8ToBase64(JSON.stringify(IMAGE_SIDECAR_FILES));
  const powershellPayload = INSTALLER_TEMPLATE
    .replace(IMAGE_SIDECAR_PLACEHOLDER, () => bundleAssignmentLines('ImageServiceBundleBase64', imageSidecarBundle));
  const payload = `${PS1_BEGIN_MARKER}\n${powershellPayload.trim()}\n${PS1_END_MARKER}`;
  const generated = CMD_TEMPLATE.replace(PAYLOAD_PLACEHOLDER, () => payload);
  // cmd.exe 对 LF-only 批处理文件的 goto 标签扫描存在缺陷，统一输出 CRLF
  return generated.replace(/\r?\n/g, '\r\n');
}

export const DISTRIBUTED_N8N_INSTALLER_FILENAME = 'install-ews-node.cmd';
