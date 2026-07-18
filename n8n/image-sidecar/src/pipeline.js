import { createHash } from 'node:crypto';
import { downloadImage, encodeJpeg } from './image.js';
import { requestUploadTicket, uploadImage } from './worker-api.js';

export async function processAndUpload(body, config, progress = async () => {}) {
  await progress('downloading');
  const source = await downloadImage(body.source_url, config);
  await progress('encoding');
  const image = await encodeJpeg(source, config);
  const sha256 = createHash('sha256').update(image).digest('hex');
  await progress('requesting_upload_ticket');
  const ticket = await requestUploadTicket(body, image, sha256, config);
  await progress('uploading');
  const etag = await uploadImage(ticket, image, config);
  return {
    r2_key: ticket.r2_key,
    size_bytes: image.length,
    sha256,
    content_type: 'image/jpeg',
    etag,
  };
}
