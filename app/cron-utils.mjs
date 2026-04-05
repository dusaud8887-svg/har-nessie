function parseCronField(field, min, max) {
  const token = String(field || '').trim();
  if (!token || token === '*') {
    return Array.from({ length: Math.max(1, max - min + 1) }, (_, index) => min + index);
  }
  const values = [];
  const segments = token.split(',').map((item) => item.trim()).filter(Boolean);
  for (const segment of segments) {
    const stepParts = segment.split('/');
    if (stepParts.length > 2) return null;
    const base = stepParts[0];
    const step = stepParts[1] != null ? Number(stepParts[1].trim()) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;
    if (base === '*') {
      for (let value = min; value <= max; value += step) values.push(value);
      continue;
    }
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
      if (start < min || end > max) return null;
      for (let value = start; value <= end; value += step) values.push(value);
      continue;
    }
    const single = Number(base);
    if (!Number.isFinite(single) || single < min || single > max) return null;
    values.push(single);
  }
  if (!values.length) return null;
  return [...new Set(values)].sort((a, b) => a - b);
}

export function parseCronExpression(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeekRaw = parseCronField(parts[4], 0, 7);
  const dayOfWeek = Array.isArray(dayOfWeekRaw) ? dayOfWeekRaw.map((value) => (value === 7 ? 0 : value)) : null;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function minuteKeyFromDate(value, now = () => new Date().toISOString()) {
  const date = value instanceof Date ? value : new Date(value || now());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}T${hour}:${minute}`;
}

export function cronMatchesNow(expression, at = new Date()) {
  const parsed = parseCronExpression(expression);
  if (!parsed) return false;
  const date = at instanceof Date ? at : new Date(at);
  return (
    parsed.minute.includes(date.getMinutes())
    && parsed.hour.includes(date.getHours())
    && parsed.dayOfMonth.includes(date.getDate())
    && parsed.month.includes(date.getMonth() + 1)
    && parsed.dayOfWeek.includes(date.getDay())
  );
}

export function findNextCronOccurrence(expression, after = new Date(), now = () => new Date().toISOString()) {
  if (!parseCronExpression(expression)) return '';
  const cursor = new Date(after instanceof Date ? after.getTime() : Date.parse(after || now()));
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let offset = 0; offset < 60 * 24 * 31; offset += 1) {
    if (cronMatchesNow(expression, cursor)) return cursor.toISOString();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return '';
}
