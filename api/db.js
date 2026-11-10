// OPAL: penyimpanan bersama (Vercel Function + Upstash Redis lewat REST). Tanpa dependensi tambahan.
// Env yang dibutuhkan: KV_REST_API_URL dan KV_REST_API_TOKEN (atau UPSTASH_REDIS_REST_URL / _TOKEN),
// OPAL_PIN_TL, OPAL_PIN_TRAINER, OPAL_PIN_ADMIN bersifat opsional: bila dikosongkan, server tidak meminta PIN (mode terbuka).
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PINS = { tl: process.env.OPAL_PIN_TL, trainer: process.env.OPAL_PIN_TRAINER, admin: process.env.OPAL_PIN_ADMIN };
// siapa boleh menulis apa
const ALLOW = {
  cs: ['tl', 'admin'], cd: ['tl', 'admin'],      // kartu
  ds: ['tl', 'trainer', 'admin'], dd: ['tl', 'trainer', 'admin'], // draf
  bk: ['tl', 'admin'],                           // status break
  ct: ['admin'], hl: ['admin'],                  // kontak, tanggal merah
  lg: ['tl', 'trainer', 'admin'],                // log
  qz: ['trainer', 'admin'],                      // kartu fokus quiz
  gs: ['tl'], gd: ['tl']                         // gamas (gangguan massal)
};
const K = { cards: 'opal:cards', drafts: 'opal:drafts', contacts: 'opal:contacts', brk: 'opal:brk', hol: 'opal:hol', qz: 'opal:qz', gm: 'opal:gm', log: 'opal:log', rev: 'opal:rev' };

async function pipe(cmds) {
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const toMap = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };
const pj = s => { try { return JSON.parse(s); } catch (e) { return null; } };
// Mode terbuka: bila PIN server untuk suatu peran tidak diisi, peran itu diterima tanpa PIN server (PIN tetap dicek di aplikasi).
const isOpen = role => !!PINS && Object.prototype.hasOwnProperty.call(PINS, role) && !PINS[role];
const okPin = (role, pin) => isOpen(role) || (!!PINS[role] && typeof pin === 'string' && pin.length > 0 && pin === PINS[role]);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!RURL || !RTOK) { res.status(503).json({ error: 'storage-belum-diatur' }); return; }
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.rev) {
        res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
        const [rev] = await pipe([['GET', K.rev]]);
        res.status(200).json({ rev: Number(rev || 0) });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      const [rev, cards, drafts, contacts, brk, hol, log, qz, gm] = await pipe([
        ['GET', K.rev], ['HGETALL', K.cards], ['HGETALL', K.drafts], ['GET', K.contacts], ['HGETALL', K.brk], ['GET', K.hol], ['LRANGE', K.log, 0, 299], ['GET', K.qz], ['HGETALL', K.gm]
      ]);
      const mapJ = a => { const m = toMap(a), o = {}; for (const k in m) { const v = pj(m[k]); if (v !== null) o[k] = v; } return o; };
      res.status(200).json({
        rev: Number(rev || 0), cards: mapJ(cards), drafts: mapJ(drafts), contacts: pj(contacts), brk: mapJ(brk), hol: pj(hol), qz: pj(qz), gm: mapJ(gm),
        log: (log || []).map(pj).filter(Boolean)
      });
      return;
    }
    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      const b = typeof req.body === 'string' ? pj(req.body) : req.body;
      if (!b || typeof b !== 'object') { res.status(400).json({ error: 'body-tidak-valid' }); return; }
      const role = String(b.role || ''), pin = String(b.pin || '');
      if (!okPin(role, pin)) { res.status(401).json({ error: 'pin-salah' }); return; }
      const ops = Array.isArray(b.ops) ? b.ops.slice(0, 400) : [];
      const cmds = [];
      for (const o of ops) {
        if (!o || !ALLOW[o.t] || !ALLOW[o.t].includes(role)) { res.status(403).json({ error: 'tidak-diizinkan', op: o && o.t }); return; }
        const id = o.id != null ? String(o.id).slice(0, 120) : '';
        const val = o.v !== undefined ? JSON.stringify(o.v) : null;
        if (val && val.length > 900000) { res.status(413).json({ error: 'terlalu-besar' }); return; }
        if (o.t === 'cs' && id && val) cmds.push(['HSET', K.cards, id, val]);
        else if (o.t === 'cd' && id) cmds.push(['HDEL', K.cards, id]);
        else if (o.t === 'ds' && id && val) cmds.push(['HSET', K.drafts, id, val]);
        else if (o.t === 'dd' && id) cmds.push(['HDEL', K.drafts, id]);
        else if (o.t === 'ct' && val) cmds.push(['SET', K.contacts, val]);
        else if (o.t === 'bk' && id) cmds.push(o.v == null ? ['HDEL', K.brk, id] : ['HSET', K.brk, id, val]);
        else if (o.t === 'hl' && val) cmds.push(['SET', K.hol, val]);
        else if (o.t === 'gs' && id && val) cmds.push(['HSET', K.gm, id, val]);
        else if (o.t === 'gd' && id) cmds.push(['HDEL', K.gm, id]);
        else if (o.t === 'qz' && val) cmds.push(['SET', K.qz, val]);
        else if (o.t === 'lg' && val) { cmds.push(['LPUSH', K.log, val]); cmds.push(['LTRIM', K.log, 0, 299]); }
      }
      let rev;
      if (cmds.length) { cmds.push(['INCR', K.rev]); const r = await pipe(cmds); rev = Number(r[r.length - 1]); }
      else { const [r] = await pipe([['GET', K.rev]]); rev = Number(r || 0); }
      res.status(200).json({ ok: true, rev, open: isOpen(role) });
      return;
    }
    res.status(405).json({ error: 'metode-tidak-didukung' });
  } catch (e) {
    res.status(500).json({ error: 'server', msg: String(e && e.message || e).slice(0, 120) });
  }
};
