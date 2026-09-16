// 공부 내기판 알림 서버 (Cloudflare Worker)
// 필요한 설정 (Cloudflare 대시보드 > Worker > Settings > Variables and Secrets)
//   SERVICE_ACCOUNT : Firebase 서비스 계정 키 JSON 전체 (Secret 으로 등록)
//   ALLOWED_ORIGIN  : https://papa1111.github.io
//   SITE_URL        : https://papa1111.github.io/study-bet/

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET") return json({ ok: true, msg: "공부 내기판 알림 서버 작동 중" }, 200, cors);
    try {
      if (req.method !== "POST") throw new HttpError(405, "POST only");
      if (!env.SERVICE_ACCOUNT) throw new HttpError(500, "SERVICE_ACCOUNT 미설정");
      const sa = JSON.parse(env.SERVICE_ACCOUNT);
      const projectId = sa.project_id;

      const idToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const sender = await verifyIdToken(idToken, projectId);

      const { group, to, title, body, includeSelf } = await req.json();
      if (!/^[a-z0-9-]{4,20}$/.test(group || "")) throw new HttpError(400, "bad group");
      if (!rateOk(sender)) throw new HttpError(429, "too many");

      const access = await getAccessToken(sa);
      const g = await fsGet(projectId, access, `groups/${group}`);
      const members = (g?.fields?.members?.arrayValue?.values || []).map(v => v.stringValue);
      if (!members.includes(sender)) throw new HttpError(403, "not a member");

      let targets = to === "all" ? members : (Array.isArray(to) ? to : []);
      targets = [...new Set(targets)].filter(u => members.includes(u) && (includeSelf || u !== sender)).slice(0, 50);

      const t = String(title || "공부 내기판").slice(0, 60);
      const b = String(body || "").slice(0, 160);
      let sent = 0;
      for (const u of targets) {
        const doc = await fsGet(projectId, access, `groups/${group}/tokens/${u}`);
        const tokens = (doc?.fields?.tokens?.arrayValue?.values || []).map(v => v.stringValue).slice(-5);
        for (const token of tokens) {
          const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
            method: "POST",
            headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
            body: JSON.stringify({
              message: {
                token,
                webpush: {
                  notification: { title: t, body: b, icon: env.SITE_URL ? env.SITE_URL + "icon-192.png" : undefined },
                  fcm_options: env.SITE_URL ? { link: env.SITE_URL } : undefined
                }
              }
            })
          });
          if (r.ok) sent++;
        }
      }
      return json({ sent }, 200, cors);
    } catch (e) {
      return json({ error: e.message }, e.status || 500, cors);
    }
  }
};

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, "content-type": "application/json" } });

// 발송 제한: 1인당 1분에 20번 (Worker 인스턴스 단위)
const hits = new Map();
function rateOk(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(x => now - x < 60000);
  if (arr.length >= 20) return false;
  arr.push(now); hits.set(uid, arr);
  return true;
}

/* ---------- base64url ---------- */
const enc = new TextEncoder();
function b64url(bytes) { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

/* ---------- Firebase 로그인 토큰 검증 ---------- */
let jwks = null, jwksAt = 0;
async function verifyIdToken(token, projectId) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "no token");
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`
      || !payload.sub || payload.exp < now || payload.iat > now + 300) throw new HttpError(401, "bad token");
  if (!jwks || Date.now() - jwksAt > 3600e3) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    jwks = (await r.json()).keys; jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new HttpError(401, "bad signature");
  return payload.sub;
}

/* ---------- 서비스 계정 → 구글 액세스 토큰 ---------- */
let cached = null;
async function getAccessToken(sa) {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + claim)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + claim + "." + b64url(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new HttpError(500, "google auth failed");
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function fsGet(projectId, access, path) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`, { headers: { authorization: `Bearer ${access}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, "firestore " + r.status);
  return r.json();
}
