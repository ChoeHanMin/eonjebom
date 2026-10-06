import { randomBytes, randomInt, createHash } from 'node:crypto';

// 공유 코드에 쓰는 글자. 헷갈리기 쉬운 0/O, 1/I/L 은 뺐다. (31자 → 8자리 약 8,500억 가지)
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;

export function generateShareCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** 사용자가 입력한 코드를 정규화한다. ('k7qm-3xpa' → 'K7QM3XPA') 형식이 틀리면 null. */
export function normalizeShareCode(input) {
  const code = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** 수정 권한 토큰. 브라우저에 저장되고, '수정 링크'로 다른 기기에 옮길 수 있다. 서버에는 해시만 저장한다. */
export function generateEditToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 잘못 인코딩된 쿠키는 무시
    }
  }
  return out;
}

/** 아주 단순한 메모리 기반 횟수 제한 (코드 무작위 대입, 대량 생성 방지용) */
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    tooMany(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        if (hits.size > 10000) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        }
        return false;
      }
      entry.count++;
      return entry.count > max;
    },
    /** 횟수를 늘리지 않고, 이미 한도에 도달했는지만 본다. */
    blocked(key, now = Date.now()) {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > now && entry.count >= max);
    },
  };
}
