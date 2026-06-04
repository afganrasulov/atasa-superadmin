import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';

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
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------------- Auth middleware ----------------
async function requireAuth(req, res, next) {
  const auth = req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const user = await verifyGotrueToken(token);
    if (!user?.email) return res.status(401).json({ error: 'invalid token' });

    // allowed_users whitelist (same as blog-admin)
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

// ---------------- Public endpoint: atasa.tr → submit ----------------
async function sendNewAppointmentEmail(appt) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL || 'afganrasulov@gmail.com';
  const from = process.env.RESEND_FROM_EMAIL || 'Atasa Superadmin <noreply@mail.atasaedu.com>';
  if (!apiKey) return;

  const html = `
    <h2>🆕 Yeni Randevu Talebi</h2>
    <p><b>${appt.first_name} ${appt.last_name}</b></p>
    <table style="border-collapse:collapse">
      <tr><td><b>📞 Telefon</b></td><td>${appt.phone || '-'}</td></tr>
      <tr><td><b>✉️ Email</b></td><td>${appt.email || '-'}</td></tr>
      <tr><td><b>🌍 Uyruk</b></td><td>${appt.nationality || '-'}</td></tr>
      <tr><td><b>📅 Tarih</b></td><td>${appt.appointment_date || '-'} ${appt.appointment_time || ''}</td></tr>
      <tr><td><b>📋 Konu</b></td><td>${appt.subject || '-'}</td></tr>
      <tr><td><b>👤 Temsilci</b></td><td>${appt.representative || '-'}</td></tr>
      <tr><td><b>📝 Açıklama</b></td><td style="max-width:500px">${(appt.description || '-').replace(/\n/g, '<br>')}</td></tr>
      <tr><td><b>🏠 Oturma</b></td><td>${appt.has_residency || '-'}${appt.residency_start_date ? ` (${appt.residency_start_date} → ${appt.residency_end_date || '-'})` : ''}</td></tr>
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
        from, to: [to],
        subject: `Yeni Randevu: ${appt.first_name} ${appt.last_name} — ${appt.appointment_date || ''} ${appt.appointment_time || ''}`,
        html,
      }),
    });
    if (!r.ok) console.error('Resend error:', await r.text());
  } catch (e) {
    console.error('Resend exception:', e.message);
  }
}

app.post('/api/appointments', async (req, res) => {
  const b = req.body || {};
  if (!b.firstName || !b.lastName) {
    return res.status(400).json({ error: 'firstName ve lastName zorunlu' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  const data = {
    ...b,
    ipAddress: ip || null,
    userAgent: ua,
    source: b.source || 'atasa.tr',
  };
  try {
    const { rows } = await pool.query(
      `SELECT atasa_mobi.insert_appointment($1::jsonb) AS id`,
      [JSON.stringify(data)],
    );
    const id = rows[0].id;
    const { rows: appt } = await pool.query(
      `SELECT * FROM atasa_mobi.appointments WHERE id=$1`,
      [id],
    );
    res.status(201).json({ success: true, id, appointment: appt[0] });
    sendNewAppointmentEmail(appt[0]).catch(() => {});
  } catch (e) {
    console.error('insert error:', e);
    res.status(500).json({ error: 'insert failed', detail: e.message });
  }
});

// ---------------- Admin endpoints (require auth) ----------------
app.get('/api/appointments', requireAuth, async (req, res) => {
  const { status, q, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(parseInt(limit, 10));
  params.push(parseInt(offset, 10));
  try {
    const { rows } = await pool.query(
      `SELECT * FROM atasa_mobi.appointments ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const { rows: counts } = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM atasa_mobi.appointments GROUP BY status`,
    );
    const stats = { new: 0, contacted: 0, scheduled: 0, completed: 0, cancelled: 0, no_show: 0, total: 0 };
    counts.forEach(c => { stats[c.status] = c.count; stats.total += c.count; });
    res.json({ appointments: rows, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/appointments/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM atasa_mobi.appointments WHERE id=$1`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/appointments/:id', requireAuth, async (req, res) => {
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
      `UPDATE atasa_mobi.appointments SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/appointments/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM atasa_mobi.appointments WHERE id=$1`,
      [req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- Whoami ----------------
app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// ---------------- Health ----------------
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------- Static files ----------------
app.use(express.static('public'));

app.listen(PORT, () => console.log(`🚀 Atasa Superadmin on port ${PORT}`));
