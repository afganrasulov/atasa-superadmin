import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import createSubscriber from 'pg-listen';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const GOTRUE_URL = process.env.GOTRUE_URL || 'https://auth.atasa.mobi';
const GOTRUE_ANON_KEY = process.env.GOTRUE_ANON_KEY || '';

async function verifyGotrueToken(accessToken) {
  const res = await fetch(`${GOTRUE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': GOTRUE_ANON_KEY,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// ---------------- Auth middleware ----------------
async function requireAuth(req, res, next) {
  const auth = req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const user = await verifyGotrueToken(token);
    if (!user?.email) return res.status(401).json({ error: 'invalid token' });

    const allowed = await pool.query(
      `SELECT name FROM atasa_mobi.allowed_users WHERE email=$1`,
      [user.email.toLowerCase()],
    );
    if (allowed.rowCount === 0) return res.status(403).json({ error: 'not allowed' });

    req.user = { id: user.id, email: user.email, name: allowed.rows[0].name };
    next();
  } catch (e) {
    res.status(401).json({ error: 'auth error', detail: e.message });
  }
}

// ---------------- Email notification (Resend) ----------------
function summarizeForm(s) {
  const TYPE = {
    appointment: '📅 Randevu',
    contact: '✉️ İletişim',
    whatsapp: '💬 WhatsApp',
  };
  return {
    typeLabel: TYPE[s.form_type] || s.form_type,
    full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || '(isim yok)',
  };
}

async function sendNewFormEmail(s) {
  const apiKey = process.env.RESEND_API_KEY;
  // Resend quota'yı korumak için: sadece Ömer Habib talepleri email gönderir.
  // Diğer tüm formlar sadece panel'de görünür.
  const wantsOmer = /ömer|omer|habib/i.test(s.representative || '');
  if (!wantsOmer) {
    console.log(`⏭️  Email skipped (no Ömer request): ${s.form_type} / ${s.first_name} ${s.last_name}`);
    return;
  }
  const to = process.env.OMER_NOTIFY_EMAIL || 'info@atasa.tr';
  const from = process.env.RESEND_FROM_EMAIL || 'Atasa Superadmin <noreply@mail.atasaedu.com>';
  if (!apiKey) return;

  const { typeLabel, full_name } = summarizeForm(s);
  const rows = [
    ['📞 Telefon', s.phone],
    ['✉️ Email', s.email],
    ['🌍 Uyruk', s.nationality],
    ['📋 Konu', s.subject],
    ['💬 Mesaj', s.message],
    ['📝 Açıklama', s.description],
    ['📅 Randevu', s.appointment_date ? `${s.appointment_date} ${s.appointment_time || ''}` : null],
    ['👤 Temsilci', s.representative],
    ['🏠 Oturma', s.has_residency],
    ['🌐 Konu (FAQ)', s.topic],
    ['❓ Soru', s.question],
    ['🔗 Kaynak', s.source],
  ];
  const html = `
    <h2>🆕 ${typeLabel}</h2>
    <p><b>${full_name}</b></p>
    <table style="border-collapse:collapse;font-family:system-ui">
      ${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td valign="top" style="padding:4px 12px 4px 0"><b>${k}</b></td><td>${String(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}
    </table>
    <p style="margin-top:20px">
      <a href="https://superadmin.atasa.tr/" style="background:#1B5FAE;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Panel'de Aç</a>
    </p>
  `;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `${typeLabel}: ${full_name}${s.appointment_date ? ` — ${s.appointment_date} ${s.appointment_time || ''}` : ''}`,
        html,
      }),
    });
    if (!r.ok) console.error('Resend error:', r.status, await r.text());
    else console.log(`📧 Email sent to ${to}: ${s.form_type} / ${full_name} (Ömer Habib)`);
  } catch (e) {
    console.error('Resend exception:', e.message);
  }
}

// ---------------- PG LISTEN — real-time form submission notifications ----------------
async function startListener() {
  const subscriber = createSubscriber({ connectionString: process.env.DATABASE_URL });
  subscriber.notifications.on('new_form_submission', (payload) => {
    console.log(`🔔 NOTIFY: ${payload?.form_type} from ${payload?.first_name}`);
    sendNewFormEmail(payload).catch(() => {});
  });
  subscriber.events.on('error', (err) => console.error('pg-listen error:', err.message));
  try {
    await subscriber.connect();
    await subscriber.listenTo('new_form_submission');
    console.log('👂 Listening for form submissions...');
  } catch (e) {
    console.error('pg-listen connect failed:', e.message);
    setTimeout(startListener, 10000);
  }
}

// ---------------- Admin endpoints ----------------
app.get('/api/forms', requireAuth, async (req, res) => {
  const { status, form_type, representative, q, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (form_type && form_type !== 'all') {
    params.push(form_type);
    conditions.push(`form_type = $${params.length}`);
  }
  if (representative === 'omer') {
    conditions.push(`(representative ILIKE '%ömer%' OR representative ILIKE '%omer%' OR representative ILIKE '%habib%')`);
  } else if (representative === 'auto') {
    conditions.push(`representative = 'Otomatik'`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length} OR message ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(parseInt(limit, 10));
  params.push(parseInt(offset, 10));
  try {
    const { rows } = await pool.query(
      `SELECT * FROM atasa_mobi.form_submissions ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const { rows: statusCounts } = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM atasa_mobi.form_submissions GROUP BY status`,
    );
    const { rows: typeCounts } = await pool.query(
      `SELECT form_type, COUNT(*)::int AS count FROM atasa_mobi.form_submissions GROUP BY form_type`,
    );
    const { rows: repCounts } = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE representative ILIKE '%ömer%' OR representative ILIKE '%omer%' OR representative ILIKE '%habib%')::int AS omer,
        COUNT(*) FILTER (WHERE representative = 'Otomatik')::int AS auto
       FROM atasa_mobi.form_submissions`,
    );
    const stats = { new: 0, contacted: 0, scheduled: 0, completed: 0, cancelled: 0, no_show: 0, spam: 0, total: 0 };
    statusCounts.forEach(c => { stats[c.status] = c.count; stats.total += c.count; });
    const byType = { appointment: 0, contact: 0, whatsapp: 0, other: 0 };
    typeCounts.forEach(c => { byType[c.form_type] = c.count; });
    const byRep = { omer: repCounts[0]?.omer || 0, auto: repCounts[0]?.auto || 0 };
    res.json({ forms: rows, stats, byType, byRep });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM atasa_mobi.form_submissions WHERE id=$1`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/forms/:id', requireAuth, async (req, res) => {
  const { status, admin_notes } = req.body;
  const updates = [];
  const params = [];
  if (status) {
    params.push(status);
    updates.push(`status = $${params.length}`);
  }
  if (admin_notes !== undefined) {
    params.push(admin_notes);
    updates.push(`admin_notes = $${params.length}`);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no updates' });
  updates.push(`updated_at = NOW()`);
  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE atasa_mobi.form_submissions SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM atasa_mobi.form_submissions WHERE id=$1`,
      [req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use(express.static('public'));

app.listen(PORT, async () => {
  console.log(`🚀 Atasa Superadmin on port ${PORT}`);
  await startListener();
});
