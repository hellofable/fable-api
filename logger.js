import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const THRESHOLD = LEVELS[LOG_LEVEL] ?? LEVELS.info;
const SUCCESS_SAMPLE = (() => {
  const v = Number.parseFloat(process.env.SUCCESS_SAMPLE ?? '0.05');
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
})();

export function log(level, event, fields = {}) {
  const sev = LEVELS[level] ?? 100;
  if (sev < THRESHOLD) return;
  const rec = { level, event, ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function logSuccessSampled(event, fields = {}) {
  if (SUCCESS_SAMPLE <= 0) return;
  if (Math.random() < SUCCESS_SAMPLE) {
    log('info', event, { sample_rate: SUCCESS_SAMPLE, ...fields });
  }
}

export { randomUUID, LEVELS, LOG_LEVEL, SUCCESS_SAMPLE };

