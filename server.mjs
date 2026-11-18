import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const personas = Object.freeze({
  manager: { id: 'manager', role: 'manager', name: '林澄', skills: [] },
  worker1: { id: 'worker1', role: 'worker', name: '何小嵐', skills: ['接待', '盤點'] },
  worker2: { id: 'worker2', role: 'worker', name: '周木生', skills: ['補貨', '場務'] },
  worker3: { id: 'worker3', role: 'worker', name: '梁雨禾', skills: ['接待', '場務'] },
});

const zones = new Map([
  ['Asia/Macau', 8], ['Asia/Hong_Kong', 8], ['Asia/Taipei', 8],
  ['Asia/Singapore', 8], ['Asia/Tokyo', 9], ['UTC', 0],
]);

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new RequestError(status, code, message);
}

function inputText(value, max, label, multiline = false) {
  const control = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || control.test(value)) {
    fail(400, 'invalid_input', `${label}須為 1 至 ${max} 個字，請去除無法顯示的字元。`);
  }
  return value.trim();
}

function instant(value, zone) {
  if (typeof value !== 'string' || !/^20[2-9]\d-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    fail(400, 'invalid_time', '請輸入完整日期與時間（2020–2099 年）。');
  }
  const naive = Date.parse(value + ':00Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== value) {
    fail(400, 'invalid_time', '日期或時間無效。');
  }
  return naive - zones.get(zone) * 3_600_000;
}

function shiftInput(body) {
  const timezone = body.timezone ?? 'Asia/Macau';
  if (!zones.has(timezone)) fail(400, 'invalid_timezone', '請選擇支援的時區。');
  const start = body.start;
  const end = body.end;
  const startsAt = instant(start, timezone);
  const endsAt = instant(end, timezone);
  if (endsAt <= startsAt) fail(400, 'invalid_time', '結束時間須晚於開始，跨午夜請選次日日期。');
  if (!Array.isArray(body.skills) || body.skills.length > 8) {
    fail(400, 'invalid_skills', '最多可填寫八個技能標籤。');
  }
  return {
    location: inputText(body.location, 80, '地點'),
    task: inputText(body.task, 240, '任務', true),
    skills: [...new Set(body.skills.map(s => inputText(s, 24, '技能標籤')))],
    start, end, timezone, startsAt, endsAt,
  };
}

async function bodyOf(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    fail(415, 'invalid_type', '請使用 JSON 格式。');
  }
  const data = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 8192) data.push(chunk);
  }
  if (size > 8192) fail(413, 'input_too_large', '資料太長。');
  let value;
  try { value = JSON.parse(Buffer.concat(data).toString('utf8')); } catch {
    fail(400, 'invalid_json', '無法讀取 JSON 資料。');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'invalid_json', '請提供 JSON 物件。');
  }
  return value;
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
};

export function createApp({ dbPath = ':memory:', seed = true, now = () => new Date() } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=4000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, persona TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY, location TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
      timezone TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      task TEXT NOT NULL, skills TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','filled','canceled')),
      cancel_reason TEXT, CHECK(ends_at > starts_at)
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), worker_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','declined','withdrawn')),
      UNIQUE (shift_id, worker_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed ON applications(shift_id) WHERE status='confirmed';
    CREATE INDEX IF NOT EXISTS confirmed_worker ON applications(worker_id) WHERE status='confirmed';
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, message TEXT NOT NULL, time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipient_notices ON notifications(recipient,id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, time TEXT NOT NULL,
      shift_id INTEGER NOT NULL REFERENCES shifts(id), detail TEXT NOT NULL
    );
  `);

  const sql = query => db.prepare(query);
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const timestamp = () => now().toISOString();
  const findShift = id => sql('SELECT * FROM shifts WHERE id=?').get(id);
  const applicationFor = (shiftId, userId) => sql(
    'SELECT id,status FROM applications WHERE shift_id=? AND worker_id=?'
  ).get(shiftId, userId) ?? null;
  function record(user, action, shiftId, detail) {
    sql('INSERT INTO audit(actor,action,time,shift_id,detail) VALUES (?,?,?,?,?)')
      .run(user.name, action, timestamp(), shiftId, detail);
  }
  function notify(userId, message) {
    sql('INSERT INTO notifications(recipient,message,time) VALUES (?,?,?)')
      .run(userId, message, timestamp());
  }
  function insertShift(s) {
    return Number(sql(`INSERT INTO shifts (location,start,end,timezone,starts_at,ends_at,task,skills)
      VALUES (?,?,?,?,?,?,?,?)`).run(s.location,s.start,s.end,s.timezone,s.startsAt,s.endsAt,s.task,JSON.stringify(s.skills)).lastInsertRowid);
  }
  function conflictFor(s, workerId) {
    return sql(`SELECT s.id,s.location,s.start,s.end,s.timezone
      FROM applications a JOIN shifts s ON s.id=a.shift_id
      WHERE a.worker_id=? AND a.status='confirmed' AND s.status='filled' AND s.id<>?
        AND s.starts_at<? AND ?<s.ends_at
      ORDER BY s.starts_at,s.id LIMIT 1`).get(workerId,s.id,s.ends_at,s.starts_at) ?? null;
  }

  if (seed) transaction(() => {
    if (!sql("INSERT OR IGNORE INTO settings(key) VALUES ('seed-v1')").run().changes) return;
    const day = new Date(Math.max(now().getTime(), Date.UTC(2020,0,1)) + 32 * 3_600_000).toISOString().slice(0, 10);
    function demo(location, task, from, to, skills) {
      const s = shiftInput({ location, task, start: day+'T'+from, end: day+'T'+to, skills });
      const id = insertShift(s);
      record(personas.manager, 'created', id, '張貼示範班次');
      return id;
    }
    const assigned = demo('南岸展室', '協助入口接待及清點備品', '09:00', '11:30', ['接待']);
    sql("INSERT INTO applications(shift_id,worker_id,status) VALUES (?,'worker1','confirmed')").run(assigned);
    sql("UPDATE shifts SET status='filled' WHERE id=?").run(assigned);
    record(personas.manager, 'confirmed', assigned, '已確認何小嵐補班');
    notify('worker1', '「南岸展室」的補班已確認。');
    const pending = demo('東廊工作間', '整理活動物資，協助開場接待', '10:00', '13:00', ['接待','場務']);
    for (const id of ['worker1','worker3']) {
      sql('INSERT INTO applications(shift_id,worker_id) VALUES (?,?)').run(pending,id);
      record(personas[id], 'applied', pending, '自願候選示範班次');
    }
    notify('manager', '「東廊工作間」有 2 位候選者待審核。');
    demo('北角工坊', '補充耗材並清點展示器具', '14:00', '17:00', ['補貨','盤點']);
  });

  function state(user = null) {
    if (!user) return { user: null, shifts: [], notifications: [], audit: [] };
    const manager = user.role === 'manager';
    const rows = manager
      ? sql('SELECT * FROM shifts ORDER BY starts_at,id').all()
      : sql(`SELECT * FROM shifts s WHERE s.status='open' OR EXISTS
        (SELECT 1 FROM applications a WHERE a.shift_id=s.id AND a.worker_id=?)
        ORDER BY starts_at,id`).all(user.id);
    return {
      user,
      shifts: rows.map(s => {
        const skills = JSON.parse(s.skills);
        const item = {
          id: s.id, location: s.location, start: s.start, end: s.end, timezone: s.timezone,
          task: s.task, skills, duration: (s.ends_at - s.starts_at) / 60_000,
          status: s.status, cancelReason: s.cancel_reason, application: manager ? null : applicationFor(s.id,user.id)
        };
        if (manager) item.candidates = sql('SELECT * FROM applications WHERE shift_id=? ORDER BY id').all(s.id).map(a => {
          const worker = personas[a.worker_id];
          return {
            id: a.id, workerId: worker.id, name: worker.name, skills: worker.skills, status: a.status,
            mismatch: skills.filter(skill => !worker.skills.includes(skill)),
            conflict: s.status === 'open' && a.status === 'pending' ? conflictFor(s,worker.id) : null,
          };
        });
        return item;
      }),
      notifications: sql('SELECT id,message,time FROM notifications WHERE recipient=? ORDER BY id DESC').all(user.id),
      audit: manager ? sql('SELECT id,actor,action,time,shift_id AS shiftId,detail FROM audit ORDER BY id DESC').all() : [],
    };
  }

  function updateShift(user, action, shiftId, applicationId, body) {
    const need = ['apply','withdraw'].includes(action) ? 'worker' : 'manager';
    if (user.role !== need) fail(403, 'forbidden', '目前的角色不能進行這項操作。');

    return transaction(() => {
      if (action === 'create') {
        const s = shiftInput(body);
        const id = insertShift(s);
        record(user,'created',id,`張貼「${s.location}」補班需求`);
        return;
      }
      const s = findShift(shiftId);
      if (!s) fail(404,'shift_not_found','找不到班次。');
      if (action === 'cancel') {
        if (s.status === 'canceled') fail(409,'shift_canceled','班次已取消。');
        const reason = inputText(body.reason,160,'取消原因',true);
        sql("UPDATE shifts SET status='canceled',cancel_reason=? WHERE id=?").run(reason,shiftId);
        record(user,'canceled',shiftId,`取消「${s.location}」：${reason}`);
        for (const a of sql("SELECT worker_id FROM applications WHERE shift_id=? AND status<>'withdrawn'").all(shiftId)) {
          notify(a.worker_id,`「${s.location}」班次已取消：${reason}`);
        }
        return;
      }
      if (s.status !== 'open') fail(409,'shift_closed','班次已確認人選或取消，無法再修改。');
      if (action === 'edit') {
        const n = shiftInput(body);
        const changed = n.location !== s.location || n.start !== s.start || n.end !== s.end
          || n.timezone !== s.timezone || n.task !== s.task || JSON.stringify(n.skills) !== s.skills;
        if (!changed) return;
        sql(`UPDATE shifts SET location=?,start=?,end=?,timezone=?,starts_at=?,ends_at=?,task=?,skills=? WHERE id=?`)
          .run(n.location,n.start,n.end,n.timezone,n.startsAt,n.endsAt,n.task,JSON.stringify(n.skills),shiftId);
        // An earlier expression of availability never consents to changed terms.
        const applicants = sql("SELECT worker_id FROM applications WHERE shift_id=? AND status='pending'").all(shiftId);
        sql("UPDATE applications SET status='withdrawn' WHERE shift_id=? AND status='pending'").run(shiftId);
        for (const a of applicants) notify(a.worker_id,`「${n.location}」的班次內容已更新。先前的候選已移除，你可查看更新後重新候選。`);
        record(user,'edited',shiftId,`更新「${n.location}」補班需求；${applicants.length} 位候選者需重新表示意願`);
        return;
      }
      if (action === 'apply' || action === 'withdraw') {
        const own = applicationFor(shiftId,user.id);
        if (action === 'apply') {
          if (own && own.status !== 'withdrawn') fail(409,'already_applied','你已對這班次提交候選。');
          if (own) sql("UPDATE applications SET status='pending' WHERE id=?").run(own.id);
          else sql('INSERT INTO applications(shift_id,worker_id) VALUES (?,?)').run(shiftId,user.id);
          record(user,'applied',shiftId,`候選「${s.location}」班次`);
          notify('manager',`${user.name}候選「${s.location}」班次。`);
        } else {
          if (own?.status !== 'pending') fail(409,'not_pending','只有待審核的候選可以撤回。');
          sql("UPDATE applications SET status='withdrawn' WHERE id=?").run(own.id);
          record(user,'withdrawn',shiftId,`撤回「${s.location}」的候選`);
          notify('manager',`${user.name}已撤回「${s.location}」的候選。`);
        }
        return;
      }

      const candidate = sql('SELECT * FROM applications WHERE id=? AND shift_id=?').get(applicationId,shiftId);
      if (!candidate) fail(404,'application_not_found','找不到候選資料。');
      if (candidate.status !== 'pending') fail(409,'not_pending','這位候選者已撤回或已有審核結果。');
      const worker = personas[candidate.worker_id];
      if (action === 'decline') {
        sql("UPDATE applications SET status='declined' WHERE id=?").run(applicationId);
        record(user,'declined',shiftId,`未選擇${worker.name}補班`);
        notify(worker.id,`「${s.location}」這次未選擇你的候選。`);
        return;
      }
      const conflict = conflictFor(s,worker.id);
      if (conflict) fail(409,'overlap',`${worker.name}已確認「${conflict.location}」的重疊班次，不能重複排班。`);
      sql("UPDATE applications SET status='confirmed' WHERE id=?").run(applicationId);
      sql("UPDATE shifts SET status='filled' WHERE id=?").run(shiftId);
      record(user,'confirmed',shiftId,`已確認${worker.name}到「${s.location}」補班`);
      notify(worker.id,`你已確認在「${s.location}」補班。`);
      for (const other of sql("SELECT id,worker_id FROM applications WHERE shift_id=? AND status='pending'").all(shiftId)) {
        sql("UPDATE applications SET status='declined' WHERE id=?").run(other.id);
        record(user,'declined',shiftId,`已確認人選；${personas[other.worker_id].name}未選上`);
        notify(other.worker_id,`「${s.location}」已確認其他人選。`);
      }
    });
  }

  const sessionFrom = req => (req.headers.cookie ?? '').split(';').map(c => c.trim())
    .find(c => /^cover_session=[a-f0-9]{64}$/.test(c))?.slice('cover_session='.length);
  const baseCookie = 'Path=/; HttpOnly; SameSite=Strict';
  function json(res, status, info) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info));
  }
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      // Refuse arbitrary Host values even if DNS points them at loopback.
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? '')) {
        fail(403,'forbidden_host','請使用本機網址。');
      }
      const url = new URL(req.url,'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith('/api/')) {
        const file = Object.hasOwn(assets,path) ? assets[path] : null;
        if (!file || !['GET','HEAD'].includes(method)) fail(404,'not_found','找不到頁面。');
        let fileData;
        try { fileData = readFileSync(new URL('./public/'+file[0],import.meta.url)); }
        catch { fail(404,'not_found','找不到頁面。'); }
        res.writeHead(200, { 'Content-Type': file[1] });
        res.end(method === 'HEAD' ? undefined : fileData);
        return;
      }
      if (method !== 'GET') {
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        if ((origin && origin !== 'http://'+req.headers.host) || (site && !['same-origin','none'].includes(site))) {
          fail(403,'forbidden_origin','請從本機應用程式操作。');
        }
      }
      const token = sessionFrom(req);
      const currentUser = () => {
        const session = token && sql('SELECT persona FROM sessions WHERE token=? AND expires>?').get(token,now().getTime());
        return session ? personas[session.persona] : null;
      };
      if (method === 'GET' && path === '/api/state') return json(res,200,state(currentUser()));

      if (method === 'POST' && path === '/api/login') {
        const { persona } = await bodyOf(req);
        if (typeof persona !== 'string' || !Object.hasOwn(personas,persona)) fail(400,'invalid_persona','請選擇示範身份。');
        const newToken = randomBytes(32).toString('hex');
        const age = 8*60*60;
        transaction(() => {
          sql('DELETE FROM sessions WHERE expires<=?').run(now().getTime());
          if (token) sql('DELETE FROM sessions WHERE token=?').run(token);
          sql('INSERT INTO sessions(token,persona,expires) VALUES (?,?,?)')
            .run(newToken,persona,now().getTime()+age*1000);
        });
        res.setHeader('Set-Cookie',`cover_session=${newToken}; ${baseCookie}; Max-Age=${age}`);
        return json(res,200,state(personas[persona]));
      }
      if (method === 'POST' && path === '/api/logout') {
        await bodyOf(req);
        if (token) sql('DELETE FROM sessions WHERE token=?').run(token);
        res.setHeader('Set-Cookie',`cover_session=; ${baseCookie}; Max-Age=0`);
        return json(res,200,state());
      }
      if (!currentUser()) fail(401,'not_signed_in','請先選擇示範身份。');
      const body = ['POST','PATCH'].includes(method) ? await bodyOf(req) : {};
      const user = currentUser();
      if (!user) fail(401,'not_signed_in','請先選擇示範身份。');
      const m = /^\/api\/shifts\/(\d+)(?:\/(cancel|apply|withdraw)|\/candidates\/(\d+)\/(confirm|decline))?$/.exec(path);
      if (method === 'POST' && path === '/api/shifts') updateShift(user,'create',null,null,body);
      else if (method === 'PATCH' && m && !m[2] && !m[4]) updateShift(user,'edit',Number(m[1]),null,body);
      else if (method === 'POST' && m && (m[2] || m[4])) updateShift(user,m[2] || m[4],Number(m[1]),Number(m[3]),body);
      else fail(404,'not_found','找不到這項功能。');
      return json(res,200,state(user));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) return json(res,error.status,{error:error.message,code:error.code});
      console.error(error);
      return json(res,500,{error:'暫時無法完成操作，請稍候再試。',code:'server_error'});
    }
  });
  return {server,db};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3030);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const {server,db} = createApp({dbPath:process.env.COVER_SHIFT_DB ?? 'cover-shift.sqlite'});
  server.listen(port,'127.0.0.1',() => console.log(`Cover Shift: http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close(() => db.close()));
}
