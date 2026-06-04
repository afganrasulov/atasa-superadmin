// Atasa SuperAdmin — frontend logic
const SUPABASE_URL = 'https://auth.atasa.mobi';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6ImF0YXNhLXNlbGYtaG9zdGVkIiwiaWF0IjoxNzgwNTIyMjk0LCJleHAiOjIwOTU4ODIyOTR9.LsZTNpx-1xsvGRa3PxIISkc5w3KGNBdYWXDXjcDV0uI';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'atasa-superadmin-auth' },
});

const STATUS_LABEL = {
  new: '🆕 Yeni',
  contacted: '📞 İletişime geçildi',
  scheduled: '📅 Planlandı',
  completed: '✅ Tamamlandı',
  cancelled: '❌ İptal',
  no_show: '🚫 Gelmedi',
};
const STATUS_ORDER = ['new', 'contacted', 'scheduled', 'completed', 'cancelled', 'no_show'];

let state = {
  user: null,
  token: null,
  appointments: [],
  stats: {},
  filter: 'all',
  search: '',
  editingId: null,
};

// ─────────── Auth ───────────
async function init() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    state.token = session.access_token;
    state.user = { email: session.user.email };
    showApp();
    loadAppointments();
  } else {
    showLogin();
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Giriş yapılıyor...';

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = 'Giriş Yap';
  if (error) {
    errEl.textContent = 'Email veya şifre hatalı';
    errEl.hidden = false;
    return;
  }
  state.token = data.session.access_token;
  state.user = { email: data.user.email };
  showApp();
  loadAppointments();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  state.token = null;
  state.user = null;
  showLogin();
});

function showLogin() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('appScreen').hidden = true;
}

function showApp() {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('appScreen').hidden = false;
  document.getElementById('userEmail').textContent = state.user.email;
}

// ─────────── API helpers ───────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    await supabaseClient.auth.signOut();
    showLogin();
    throw new Error('Oturum süresi doldu');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─────────── List + stats ───────────
async function loadAppointments() {
  const tableEl = document.getElementById('apptTable');
  const loadingEl = document.getElementById('loadingRow');
  const emptyEl = document.getElementById('emptyState');
  loadingEl.hidden = false;
  tableEl.hidden = true;
  emptyEl.hidden = true;

  try {
    const params = new URLSearchParams();
    if (state.filter !== 'all') params.set('status', state.filter);
    if (state.search) params.set('q', state.search);
    const data = await api(`/api/appointments?${params}`);
    state.appointments = data.appointments;
    state.stats = data.stats;
    renderStats();
    renderTable();
  } catch (e) {
    toast(e.message);
  } finally {
    loadingEl.hidden = true;
  }
}

function renderStats() {
  const items = [
    { key: 'total', label: 'Toplam', color: 'bg-slate-100 text-slate-800' },
    { key: 'new', label: 'Yeni', color: 'bg-amber-100 text-amber-800' },
    { key: 'contacted', label: 'İletişim', color: 'bg-blue-100 text-blue-800' },
    { key: 'scheduled', label: 'Planlandı', color: 'bg-indigo-100 text-indigo-800' },
    { key: 'completed', label: 'Tamamlandı', color: 'bg-emerald-100 text-emerald-800' },
    { key: 'cancelled', label: 'İptal', color: 'bg-red-100 text-red-800' },
  ];
  document.getElementById('statsRow').innerHTML = items.map(it => `
    <div class="bg-white rounded-xl border p-4">
      <div class="text-xs uppercase tracking-wider text-slate-500">${it.label}</div>
      <div class="text-2xl font-bold ${it.color.split(' ')[1]} mt-1">${state.stats[it.key] || 0}</div>
    </div>
  `).join('');

  document.getElementById('filterTabs').innerHTML = [
    { key: 'all', label: 'Tümü' },
    { key: 'new', label: STATUS_LABEL.new },
    { key: 'contacted', label: STATUS_LABEL.contacted },
    { key: 'scheduled', label: STATUS_LABEL.scheduled },
    { key: 'completed', label: STATUS_LABEL.completed },
    { key: 'cancelled', label: STATUS_LABEL.cancelled },
  ].map(f => `
    <button data-filter="${f.key}" class="px-3 py-1.5 text-sm rounded-lg border ${state.filter === f.key ? 'tab-active border-blue-700' : 'bg-white hover:bg-slate-50 border-slate-200'}">
      ${f.label}
    </button>
  `).join('');

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      loadAppointments();
    });
  });
}

function renderTable() {
  const tbody = document.getElementById('apptTableBody');
  const tableEl = document.getElementById('apptTable');
  const emptyEl = document.getElementById('emptyState');

  if (state.appointments.length === 0) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  tableEl.hidden = false;
  emptyEl.hidden = true;

  tbody.innerHTML = state.appointments.map(a => `
    <tr class="hover:bg-slate-50 cursor-pointer" data-id="${a.id}">
      <td class="p-3 text-xs text-slate-500">${formatDate(a.created_at)}</td>
      <td class="p-3">
        <div class="font-medium">${escapeHtml(a.first_name)} ${escapeHtml(a.last_name)}</div>
        <div class="text-xs text-slate-500">${escapeHtml(a.nationality || '')}</div>
      </td>
      <td class="p-3 text-xs">
        ${a.phone ? `<div>📞 ${escapeHtml(a.phone)}</div>` : ''}
        ${a.email ? `<div class="text-slate-500">${escapeHtml(a.email)}</div>` : ''}
      </td>
      <td class="p-3 text-xs">${escapeHtml(a.subject || '-')}</td>
      <td class="p-3 text-xs">
        ${a.appointment_date ? `<div>${a.appointment_date}</div>` : ''}
        ${a.appointment_time ? `<div class="text-slate-500">${escapeHtml(a.appointment_time)}</div>` : ''}
      </td>
      <td class="p-3 text-xs">${escapeHtml(a.representative || '-')}</td>
      <td class="p-3">
        <span class="px-2 py-1 text-xs font-medium rounded-full status-${a.status}">
          ${STATUS_LABEL[a.status] || a.status}
        </span>
      </td>
      <td class="p-3 text-right">
        <button class="text-blue-600 hover:text-blue-700 text-sm">Detay →</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.id));
  });
}

// ─────────── Detail modal ───────────
function openDetail(id) {
  const a = state.appointments.find(x => x.id === id);
  if (!a) return;
  state.editingId = id;
  document.getElementById('modalTitle').textContent = `${a.first_name} ${a.last_name}`;
  document.getElementById('modalBody').innerHTML = `
    <div class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
      <div><b>📞 Telefon:</b> <a href="tel:${a.phone}" class="text-blue-600">${escapeHtml(a.phone || '-')}</a></div>
      <div><b>✉️ Email:</b> <a href="mailto:${a.email}" class="text-blue-600">${escapeHtml(a.email || '-')}</a></div>
      <div><b>🌍 Uyruk:</b> ${escapeHtml(a.nationality || '-')}</div>
      <div><b>👫 Cinsiyet:</b> ${escapeHtml(a.gender || '-')}</div>
      <div><b>🎂 Doğum:</b> ${a.birth_date || '-'}</div>
      <div><b>📅 Randevu:</b> ${a.appointment_date || '-'} ${a.appointment_time || ''}</div>
      <div><b>👤 Temsilci:</b> ${escapeHtml(a.representative || '-')}</div>
      <div><b>🏠 Oturma:</b> ${escapeHtml(a.has_residency || '-')}</div>
      ${a.residency_start_date ? `<div class="col-span-2 text-xs text-slate-500">Oturma: ${a.residency_start_date} → ${a.residency_end_date || '-'}</div>` : ''}
    </div>
    <div>
      <div class="text-sm font-medium text-slate-700 mb-1">📋 Konu</div>
      <div class="bg-slate-50 rounded-lg p-3 text-sm">${escapeHtml(a.subject || '-')}</div>
    </div>
    <div>
      <div class="text-sm font-medium text-slate-700 mb-1">📝 Açıklama</div>
      <div class="bg-slate-50 rounded-lg p-3 text-sm whitespace-pre-wrap">${escapeHtml(a.description || '-')}</div>
    </div>
    <div>
      <label class="text-sm font-medium text-slate-700 block mb-1.5">Durum</label>
      <select id="modalStatus" class="w-full px-3 py-2 border rounded-lg text-sm">
        ${STATUS_ORDER.map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="text-sm font-medium text-slate-700 block mb-1.5">Admin Notları</label>
      <textarea id="modalNotes" rows="3" placeholder="İç notlarınız..."
        class="w-full px-3 py-2 border rounded-lg text-sm">${escapeHtml(a.admin_notes || '')}</textarea>
    </div>
    <div class="text-xs text-slate-400 pt-2 border-t">
      <div>ID: <code>${a.id}</code></div>
      <div>Oluşturuldu: ${formatDate(a.created_at)} ${a.ip_address ? `(${a.ip_address})` : ''}</div>
      ${a.updated_at !== a.created_at ? `<div>Güncellendi: ${formatDate(a.updated_at)}</div>` : ''}
    </div>
  `;
  document.getElementById('detailModal').hidden = false;
}

window.closeModal = function () {
  document.getElementById('detailModal').hidden = true;
  state.editingId = null;
};

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!state.editingId) return;
  const status = document.getElementById('modalStatus').value;
  const admin_notes = document.getElementById('modalNotes').value;
  try {
    await api(`/api/appointments/${state.editingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, admin_notes }),
    });
    closeModal();
    toast('Kaydedildi ✓');
    loadAppointments();
  } catch (e) {
    toast('Hata: ' + e.message);
  }
});

document.getElementById('deleteBtn').addEventListener('click', async () => {
  if (!state.editingId) return;
  if (!confirm('Bu randevuyu silmek istediğinize emin misiniz?')) return;
  try {
    await api(`/api/appointments/${state.editingId}`, { method: 'DELETE' });
    closeModal();
    toast('Silindi');
    loadAppointments();
  } catch (e) {
    toast('Hata: ' + e.message);
  }
});

// ─────────── Search + refresh ───────────
let searchTimer;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    loadAppointments();
  }, 300);
});

document.getElementById('refreshBtn').addEventListener('click', loadAppointments);

// ─────────── Utils ───────────
function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2800);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

init();

// Auto-refresh every 60s
setInterval(() => {
  if (state.token && !document.getElementById('detailModal').hidden === false) {
    loadAppointments();
  }
}, 60000);
