// Delivering a finished bundle into a T3 thread.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadBundle } from './pipeline.mjs';
import { renderDeliveryMessage } from './feedback.mjs';
import { fmtDuration, humanLocal } from './util.mjs';

/**
 * target: { threadId?, projectPath?, note? }. Returns a delivery record:
 * { state: 'sent'|'failed', threadId?, link?, sentAt?, error?, messagePath }.
 */
export async function deliverBundle(t3, dir, target) {
  const bundle = loadBundle(dir);
  if (!bundle) throw new Error(`not a finished bundle: ${dir}`);
  const message = renderDeliveryMessage(bundle, { note: target.note });
  const messagePath = path.join(dir, 'delivery-message.txt');
  await fsp.writeFile(messagePath, message + '\n');
  try {
    let res;
    if (target.threadId) res = await t3.send(target.threadId, message);
    else if (target.projectPath) {
      const when = humanLocal(new Date(bundle.recordedAt || Date.now()));
      const title = `Phone feedback ${when} (${fmtDuration(bundle.durationSec)})`;
      res = await t3.start(target.projectPath, message, title);
    } else throw new Error('no threadId or projectPath to deliver to');
    return { state: 'sent', threadId: res.threadId, ...(res.link ? { link: res.link } : {}), sentAt: new Date().toISOString(), messagePath };
  } catch (err) {
    return { state: 'failed', ...(target.threadId ? { threadId: target.threadId } : {}), error: String(err.message || err).slice(0, 1000), messagePath };
  }
}
