// Atasa SuperAdmin — frontend logic (form_submissions tek tablo)
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
  spam: '🗑️ Spam',
};
const STATUS_ORDER = ['new', 'contacted', 'scheduled', 'completed', 'cancelled', 'no_show', 'spam'];

const TYPE_LABEL = {
  appointment: '📅 Randevu',
  contact: '✉️ İletişim',
  whatsapp: '💬 WhatsApp',
  other: '📄 Diğer',
};

const PROJECTS = [
  { key: 'atasa', label: '🌐 Atasa.tr' },
  { key: 'atasakurumsal', label: '🏢 Atasa Kurumsal' },
];

let state = {
  user: null,
  token: null,
  forms: [],
  stats: {},
  byType: {},
  byRep: {},
  projectFilter: 'atasa',
  statusFilter: 'all',
  typeFilter: 'all',
  repFilter: 'all',
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
    loadForms();
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
  loadForms();
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
async function loadForms() {
  const tableEl = document.getElementById('apptTable');
  const loadingEl = document.getElementById('loadingRow');
  const emptyEl = document.getElementById('emptyState');
  loadingEl.hidden = false;
  tableEl.hidden = true;
  emptyEl.hidden = true;

  try {
    const params = new URLSearchParams();
    params.set('project', state.projectFilter);
    if (state.statusFilter !== 'all') params.set('status', state.statusFilter);
    if (state.typeFilter !== 'all') params.set('form_type', state.typeFilter);
    if (state.repFilter !== 'all') params.set('representative', state.repFilter);
    if (state.search) params.set('q', state.search);
    const data = await api(`/api/forms?${params}`);
    state.forms = data.forms;
    state.stats = data.stats;
    state.byType = data.byType;
    state.byRep = data.byRep || { omer: 0, auto: 0 };
    renderStats();
    renderTable();
  } catch (e) {
    toast(e.message);
  } finally {
    loadingEl.hidden = true;
  }
}

function renderStats() {
  // Proje sekmeleri (üstte, belirgin)
  document.getElementById('projectTabs').innerHTML = PROJECTS.map(p => `
    <button data-project="${p.key}" class="px-4 py-2 text-sm font-semibold rounded-lg border ${state.projectFilter === p.key ? 'tab-active border-blue-700' : 'bg-white hover:bg-slate-50 border-slate-200'}">
      ${p.label}
    </button>
  `).join('');
  document.querySelectorAll('[data-project]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.projectFilter === btn.dataset.project) return;
      state.projectFilter = btn.dataset.project;
      // Proje değişince diğer filtreleri sıfırla (temsilci filtresi atasa'ya özel)
      state.statusFilter = 'all';
      state.typeFilter = 'all';
      state.repFilter = 'all';
      state.search = '';
      const searchEl = document.getElementById('searchInput');
      if (searchEl) searchEl.value = '';
      loadForms();
    });
  });

  const items = [
    { key: 'total', label: 'Toplam', color: 'text-slate-800' },
    { key: 'new', label: 'Yeni', color: 'text-amber-700' },
    { key: 'contacted', label: 'İletişim', color: 'text-blue-700' },
    { key: 'scheduled', label: 'Planlandı', color: 'text-indigo-700' },
    { key: 'completed', label: 'Tamamlandı', color: 'text-emerald-700' },
    { key: 'cancelled', label: 'İptal', color: 'text-red-700' },
  ];
  document.getElementById('statsRow').innerHTML = items.map(it => `
    <div class="bg-white rounded-xl border p-4">
      <div class="text-xs uppercase tracking-wider text-slate-500">${it.label}</div>
      <div class="text-2xl font-bold ${it.color} mt-1">${state.stats[it.key] || 0}</div>
    </div>
  `).join('');

  // Form type tabs
  const typeTabs = [
    { key: 'all', label: 'Tüm Tipler', count: state.stats.total },
    { key: 'appointment', label: TYPE_LABEL.appointment, count: state.byType.appointment || 0 },
    { key: 'whatsapp', label: TYPE_LABEL.whatsapp, count: state.byType.whatsapp || 0 },
    { key: 'contact', label: TYPE_LABEL.contact, count: state.byType.contact || 0 },
  ];
  document.getElementById('typeTabs').innerHTML = typeTabs.map(t => `
    <button data-type="${t.key}" class="px-3 py-1.5 text-sm rounded-lg border ${state.typeFilter === t.key ? 'tab-active border-blue-700' : 'bg-white hover:bg-slate-50 border-slate-200'}">
      ${t.label} <span class="opacity-60 ml-1">(${t.count})</span>
    </button>
  `).join('');

  // Status tabs
  const statusTabs = [
    { key: 'all', label: 'Tüm Durumlar' },
    { key: 'new', label: STATUS_LABEL.new },
    { key: 'contacted', label: STATUS_LABEL.contacted },
    { key: 'scheduled', label: STATUS_LABEL.scheduled },
    { key: 'completed', label: STATUS_LABEL.completed },
    { key: 'cancelled', label: STATUS_LABEL.cancelled },
  ];
  document.getElementById('statusTabs').innerHTML = statusTabs.map(f => `
    <button data-status="${f.key}" class="px-3 py-1.5 text-sm rounded-lg border ${state.statusFilter === f.key ? 'tab-active border-blue-700' : 'bg-white hover:bg-slate-50 border-slate-200'}">
      ${f.label}
    </button>
  `).join('');

  // Representative tabs (Ömer'le özel görüşmek isteyenler vs) — sadece atasa projesinde
  const repTabs = state.projectFilter === 'atasa' ? [
    { key: 'all', label: '👥 Tüm Temsilciler', count: state.stats.total },
    { key: 'omer', label: '👤 Ömer Habib ile (özel)', count: state.byRep.omer || 0, highlight: true },
    { key: 'auto', label: '⚙️ Otomatik atanan', count: state.byRep.auto || 0 },
  ] : [];
  document.getElementById('repTabs').innerHTML = repTabs.map(t => `
    <button data-rep="${t.key}" class="px-3 py-1.5 text-sm rounded-lg border ${state.repFilter === t.key ? 'tab-active border-blue-700' : t.highlight ? 'bg-amber-50 hover:bg-amber-100 border-amber-300' : 'bg-white hover:bg-slate-50 border-slate-200'}">
      ${t.label} <span class="opacity-60 ml-1">(${t.count})</span>
    </button>
  `).join('');

  document.querySelectorAll('[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.typeFilter = btn.dataset.type;
      loadForms();
    });
  });
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.statusFilter = btn.dataset.status;
      loadForms();
    });
  });
  document.querySelectorAll('[data-rep]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.repFilter = btn.dataset.rep;
      loadForms();
    });
  });
}

function renderTable() {
  const tbody = document.getElementById('apptTableBody');
  const tableEl = document.getElementById('apptTable');
  const emptyEl = document.getElementById('emptyState');

  if (state.forms.length === 0) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  tableEl.hidden = false;
  emptyEl.hidden = true;

  tbody.innerHTML = state.forms.map(a => {
    const typeIcon = TYPE_LABEL[a.form_type] || `📄 ${a.form_type}`;
    const summary = a.subject || a.topic || a.message?.slice(0, 60) || a.description?.slice(0, 60) || '-';
    const wantsOmer = a.representative && /ömer|omer|habib/i.test(a.representative);
    const omerBadge = wantsOmer ? '<div class="mt-1 inline-block px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-semibold">👤 Ömer Habib</div>' : '';
    const apptInfo = a.appointment_date
      ? `<div>${a.appointment_date}${a.appointment_time ? ` ${escapeHtml(a.appointment_time)}` : ''}</div>${omerBadge}`
      : (omerBadge || '<span class="text-slate-300">-</span>');
    return `
      <tr class="hover:bg-slate-50 cursor-pointer" data-id="${a.id}">
        <td class="p-3 text-xs text-slate-500">${formatDate(a.created_at)}</td>
        <td class="p-3 text-xs"><span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700">${typeIcon}</span></td>
        <td class="p-3">
          <div class="font-medium">${escapeHtml(a.first_name)} ${escapeHtml(a.last_name || '')}</div>
          <div class="text-xs text-slate-500">${escapeHtml(a.nationality || '')}</div>
        </td>
        <td class="p-3 text-xs">
          ${a.phone ? `<div>📞 ${escapeHtml(a.phone)}</div>` : ''}
          ${a.email ? `<div class="text-slate-500">${escapeHtml(a.email)}</div>` : ''}
        </td>
        <td class="p-3 text-xs">${escapeHtml(summary)}</td>
        <td class="p-3 text-xs">${apptInfo}</td>
        <td class="p-3">
          <span class="px-2 py-1 text-xs font-medium rounded-full status-${a.status || 'new'}">
            ${STATUS_LABEL[a.status] || a.status || '🆕 Yeni'}
          </span>
        </td>
        <td class="p-3 text-right">
          <button class="text-blue-600 hover:text-blue-700 text-sm">Detay →</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.id));
  });
}

// ─────────── Detail modal ───────────
function field(label, value) {
  if (!value) return '';
  return `<div><b class="text-slate-600">${label}:</b> ${escapeHtml(String(value))}</div>`;
}

function openDetail(id) {
  const a = state.forms.find(x => x.id === id);
  if (!a) return;
  state.editingId = id;
  document.getElementById('modalTitle').textContent = `${TYPE_LABEL[a.form_type] || a.form_type} — ${a.first_name} ${a.last_name || ''}`;

  const bigText = (label, val) => val
    ? `<div><div class="text-sm font-medium text-slate-700 mb-1">${label}</div><div class="bg-slate-50 rounded-lg p-3 text-sm whitespace-pre-wrap">${escapeHtml(val)}</div></div>`
    : '';

  document.getElementById('modalBody').innerHTML = `
    <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      ${a.phone ? `<div><b>📞 Telefon:</b> <a href="tel:${a.phone}" class="text-blue-600">${escapeHtml(a.phone)}</a></div>` : ''}
      ${a.email ? `<div><b>✉️ Email:</b> <a href="mailto:${a.email}" class="text-blue-600">${escapeHtml(a.email)}</a></div>` : ''}
      ${field('🌍 Uyruk', a.nationality)}
      ${field('👫 Cinsiyet', a.gender)}
      ${field('🎂 Doğum', a.birth_date)}
      ${a.appointment_date ? `<div><b>📅 Randevu:</b> ${a.appointment_date} ${a.appointment_time || ''}</div>` : ''}
      ${field('👤 Temsilci', a.representative)}
      ${field('🏠 Oturma', a.has_residency)}
      ${(a.residency_start_date || a.residency_end_date) ? `<div class="col-span-2 text-xs text-slate-500">Oturma: ${a.residency_start_date || '-'} → ${a.residency_end_date || '-'}</div>` : ''}
      ${field('🌐 Konu (Topic)', a.topic)}
    </div>
    ${bigText('📋 Konu', a.subject)}
    ${bigText('💬 Mesaj', a.message)}
    ${bigText('📝 Açıklama', a.description)}
    ${bigText('❓ Soru', a.question)}
    <div>
      <label class="text-sm font-medium text-slate-700 block mb-1.5">Durum</label>
      <select id="modalStatus" class="w-full px-3 py-2 border rounded-lg text-sm">
        ${STATUS_ORDER.map(s => `<option value="${s}" ${(a.status || 'new') === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="text-sm font-medium text-slate-700 block mb-1.5">Admin Notları</label>
      <textarea id="modalNotes" rows="3" placeholder="İç notlarınız..."
        class="w-full px-3 py-2 border rounded-lg text-sm">${escapeHtml(a.admin_notes || '')}</textarea>
    </div>
    <div class="text-xs text-slate-400 pt-2 border-t">
      <div>Tip: <code>${a.form_type}</code> · Kaynak: <code>${a.source || 'web'}</code></div>
      <div>ID: <code>${a.id}</code></div>
      <div>Oluşturuldu: ${formatDate(a.created_at)} ${a.ip_address ? `· IP: ${a.ip_address}` : ''}</div>
      ${a.updated_at && a.updated_at !== a.created_at ? `<div>Güncellendi: ${formatDate(a.updated_at)}</div>` : ''}
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
    await api(`/api/forms/${state.editingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, admin_notes }),
    });
    closeModal();
    toast('Kaydedildi ✓');
    loadForms();
  } catch (e) {
    toast('Hata: ' + e.message);
  }
});

document.getElementById('deleteBtn').addEventListener('click', async () => {
  if (!state.editingId) return;
  if (!confirm('Bu kaydı silmek istediğinize emin misiniz?')) return;
  try {
    await api(`/api/forms/${state.editingId}`, { method: 'DELETE' });
    closeModal();
    toast('Silindi');
    loadForms();
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
    loadForms();
  }, 300);
});

document.getElementById('refreshBtn').addEventListener('click', loadForms);

// ─────────── Utils ───────────
function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
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
  if (state.token && document.getElementById('detailModal').hidden) {
    loadForms();
  }
}, 60000);
