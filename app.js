const STORAGE_KEY = 'box_of_fragments_state_v1';
const SETTINGS_KEY = 'box_of_fragments_settings_v1';

const SYSTEM_PROMPT =
  '你是一位温柔、沉静的倾听者与共情式伙伴。你的目标是帮助用户把感受说清楚、把需要看见、把下一步变得更轻。' +
  '除非用户主动提起，否则不要提及任何“盒子/木箱/封存/卷轴/仪式”等设定，也不要反复暗示用户去封存。' +
  '不要输出你的思考过程（thinking），只输出最终回复。回复简洁一些，多用问题引导用户主导。';

const DEFAULT_PROXY = 'http://127.0.0.1:8787/api/chat';

/** @typedef {{role:'user'|'assistant', content:string, imageDataUrl?:string, imageDataUrls?:string[], ts:number}} ChatMsg */
/** @typedef {{id:string, x:number, y:number, z:number, title:string, createdAt:number, updatedAt:number, sealed?:boolean, sealedAt?:number, history:ChatMsg[]}} BoxState */
/** @typedef {{version:1, boxes:BoxState[]}} AppState */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const elCanvas = $('#canvas');
const elOverlay = $('#scroll-overlay');
const elPaper = $('#scroll-paper');
const elClose = $('#btn-close');
const elTitle = /** @type {HTMLInputElement} */ ($('#box-title-edit'));
const elChat = $('#chat-area');
const elInput = /** @type {HTMLTextAreaElement} */ ($('#user-input'));
const elSend = $('#btn-send');
const elSeal = $('#btn-seal');
const elSealBanner = $('#seal-banner');
const elAttach = $('#btn-attach');
const elImageInput = /** @type {HTMLInputElement} */ ($('#image-input'));
const elAttachment = $('#attachment-preview');
const elAttachmentList = $('#attachment-list');
const elAttachmentHint = $('#attachment-hint');
const elNewBox = $('#btn-new-box');
const elSettingsBtn = $('#btn-settings');
const elStatus = $('#agent-status');

const elSettingsOverlay = $('#settings-overlay');
const elSettingsPanel = $('#settings-panel');
const elSettingsClose = $('#btn-settings-close');
const elProxyInput = /** @type {HTMLInputElement} */ ($('#agent-proxy-url'));
const elTestAgent = $('#btn-test-agent');

let state = loadState();
let currentBoxId = null;
let isSending = false;
let currentAbort = null;
const TYPING_ID = 'agent-typing-indicator';
const MAX_ATTACHMENTS = 10;
let pendingImageDataUrls = /** @type {string[]} */ ([]);
const INPUT_MIN_PX = 48;
const INPUT_MAX_PX = 140;
let lastAgentMeta = /** @type {{provider?:string, model?:string} | null} */ (null);

function scrollChatToBottom() {
  // If the dialog is still animating / not yet visible, scrolling immediately can fail.
  requestAnimationFrame(() => {
    elChat.scrollTop = elChat.scrollHeight;
  });
}

function autosizeInput() {
  if (!elInput) return;
  elInput.style.height = 'auto';
  const desired = Math.max(INPUT_MIN_PX, elInput.scrollHeight);
  const next = Math.min(INPUT_MAX_PX, desired);
  elInput.style.height = `${next}px`;
  // Once we hit the cap, allow scrolling inside the textarea.
  elInput.style.overflowY = desired > INPUT_MAX_PX ? 'auto' : 'hidden';
}

function setSendingUI(sending) {
  elSend.classList.toggle('is-sending', !!sending);
  elSend.setAttribute('aria-label', sending ? '暂停' : '发送');
  elSend.title = sending ? '暂停' : '发送';
  elSend.disabled = false; // keep clickable for stop
  elInput.disabled = !!sending;
  elInput.setAttribute('aria-disabled', sending ? 'true' : 'false');
  if (elSeal) elSeal.disabled = !!sending;
  if (elAttach) elAttach.disabled = !!sending;
}

function renderAttachmentList() {
  if (!elAttachment || !elAttachmentList || !elAttachmentHint) return;
  elAttachmentList.innerHTML = '';
  if (!pendingImageDataUrls.length) {
    elAttachment.hidden = true;
    elAttachmentHint.textContent = '';
    return;
  }
  for (let i = 0; i < pendingImageDataUrls.length; i++) {
    const url = pendingImageDataUrls[i];
    const item = document.createElement('div');
    item.className = 'attachment-item';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `已选择图片 ${i + 1}`;
    img.loading = 'lazy';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attachment-remove';
    btn.textContent = '×';
    btn.title = '移除';
    btn.setAttribute('aria-label', '移除图片');
    btn.addEventListener('click', () => removeAttachmentAt(i));
    item.appendChild(img);
    item.appendChild(btn);
    elAttachmentList.appendChild(item);
  }
  const base = `${pendingImageDataUrls.length}/${MAX_ATTACHMENTS}`;
  const model = (lastAgentMeta?.model || '').trim();
  const mayNotSee =
    model &&
    !/(vision|vl|4v|4\.v|image|multi)/i.test(model); // heuristic only
  elAttachmentHint.textContent = mayNotSee
    ? `${base} · 当前模型（${model}）可能不支持看图`
    : `${base}`;
  elAttachment.hidden = false;
}

function setAttachments(urls) {
  pendingImageDataUrls = Array.isArray(urls) ? urls.slice(0, MAX_ATTACHMENTS) : [];
  renderAttachmentList();
}

function dataUrlToMime(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,/i);
  return m ? m[1] : '';
}

async function compressImageToDataUrl(file) {
  // Keep it simple + fast: resize longest edge to <= 1024 and export JPEG.
  const maxEdge = 1024;
  const bmp = await createImageBitmap(file);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法处理图片（Canvas 不可用）');
  ctx.drawImage(bmp, 0, 0, tw, th);
  // Prefer jpeg for size; keep decent quality.
  const out = canvas.toDataURL('image/jpeg', 0.82);
  if (!out.startsWith('data:image/')) throw new Error('图片处理失败');
  // Hard cap per image to avoid bloating localStorage.
  if (out.length > 1_200_000) throw new Error('图片太大，请换一张更小的或裁剪后再试');
  return out;
}

function openFilePicker() {
  if (!elImageInput) return;
  elImageInput.value = '';
  elImageInput.click();
}

async function onPickImage() {
  const files = Array.from(elImageInput?.files || []);
  if (!files.length) return;
  const room = MAX_ATTACHMENTS - pendingImageDataUrls.length;
  if (room <= 0) {
    alert(`最多只能添加 ${MAX_ATTACHMENTS} 张图片`);
    return;
  }
  const picked = files.slice(0, room);
  try {
    const next = [...pendingImageDataUrls];
    for (const f of picked) {
      if (!String(f.type || '').startsWith('image/')) continue;
      if (f.size > 12 * 1024 * 1024) throw new Error('图片太大（>12MB），请换一张更小的');
      const dataUrl = await compressImageToDataUrl(f);
      if (!dataUrlToMime(dataUrl)) throw new Error('无法识别图片格式');
      next.push(dataUrl);
    }
    // total cap (rough): ~6MB base64
    const total = next.reduce((s, u) => s + u.length, 0);
    if (total > 6_000_000) throw new Error('图片总大小太大，请减少图片数量或换更小的图片');
    setAttachments(next);
  } catch (e) {
    console.warn(e);
    alert(String(e?.message || e));
  }
}

function removeAttachmentAt(idx) {
  const next = pendingImageDataUrls.filter((_, i) => i !== idx);
  setAttachments(next);
}

function clearAttachments() {
  setAttachments([]);
}

function removeTypingIndicator() {
  const el = elChat.querySelector(`#${TYPING_ID}`);
  if (el) el.remove();
}

function showTypingIndicator() {
  removeTypingIndicator();
  const div = document.createElement('div');
  div.id = TYPING_ID;
  div.className = 'message agent typing';
  div.innerHTML = `<span>正在输入</span><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>`;
  elChat.appendChild(div);
  scrollChatToBottom();
}

// --- Audio (happy open/close) ---
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
function playOpenSound() {
  const now = audioContext.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + i * 0.1);
    gain.gain.setValueAtTime(0, now + i * 0.1);
    gain.gain.linearRampToValueAtTime(0.14, now + i * 0.1 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.35);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(now + i * 0.1);
    osc.stop(now + i * 0.1 + 0.36);
  });
}
function playCloseSound() {
  const now = audioContext.currentTime;
  [783.99, 659.25, 523.25].forEach((freq, i) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + i * 0.08);
    gain.gain.setValueAtTime(0.1, now + i * 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.25);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(now + i * 0.08);
    osc.stop(now + i * 0.08 + 0.26);
  });
}

// --- Settings ---
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      agentProxyUrl: typeof s.agentProxyUrl === 'string' && s.agentProxyUrl.trim() ? s.agentProxyUrl.trim() : DEFAULT_PROXY,
    };
  } catch {
    return { agentProxyUrl: DEFAULT_PROXY };
  }
}
function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function setStatus(ok, text) {
  elStatus.classList.toggle('ok', !!ok);
  elStatus.classList.toggle('bad', ok === false);
  elStatus.textContent = text;
}
let settings = loadSettings();
elProxyInput.value = settings.agentProxyUrl;

// --- Persistence ---
function loadState() {
  /** @type {AppState} */
  const fallback = {
    version: 1,
    boxes: [],
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.boxes)) return fallback;
    return /** @type {AppState} */ (parsed);
  } catch {
    return fallback;
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function makeNewBox({ x, y, title }) {
  const now = Date.now();
  return {
    id: uid(),
    x,
    y,
    z: now,
    title: title || '记忆盒子',
    createdAt: now,
    updatedAt: now,
    sealed: false,
    history: [],
  };
}

function getBox(id) {
  return state.boxes.find((b) => b.id === id) || null;
}
function bumpZ(box) {
  box.z = Date.now();
  box.updatedAt = Date.now();
}

// --- Render boxes ---
function renderBoxes() {
  elCanvas.innerHTML = '';
  const sorted = [...state.boxes].sort((a, b) => a.z - b.z);
  for (const b of sorted) elCanvas.appendChild(renderBoxEl(b));
  renderEmptyState();
}

function renderEmptyState() {
  const existing = elCanvas.querySelector('[data-empty-state="1"]');
  if (state.boxes.length) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const div = document.createElement('div');
  div.dataset.emptyState = '1';
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-title">这里还没有碎片</div>
    <div class="empty-sub">当你准备好了，点左上角 <b>“+ 新建盒子”</b>。</div>
  `;
  elCanvas.appendChild(div);
}

function renderBoxEl(box) {
  const div = document.createElement('div');
  div.className = `box${box.sealed ? ' sealed' : ''}`;
  div.dataset.boxId = box.id;
  div.style.left = `${box.x}px`;
  div.style.top = `${box.y}px`;
  div.style.zIndex = String(Math.floor(box.z / 1000));

  const latch = document.createElement('div');
  latch.className = 'latch';
  latch.setAttribute('aria-hidden', 'true');
  div.appendChild(latch);

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = box.title || '记忆盒子';
  div.appendChild(label);

  // drag
  div.addEventListener('mousedown', (e) => startDrag(e, box.id));

  // open (double click)
  div.addEventListener('dblclick', () => openScroll(box.id));

  // bring to front on click
  div.addEventListener('click', () => {
    const b = getBox(box.id);
    if (!b) return;
    bumpZ(b);
    saveState();
    // update z immediately
    div.style.zIndex = String(Math.floor(b.z / 1000));
  });

  return div;
}

function getBoxEl(id) {
  return /** @type {HTMLElement|null} */ (elCanvas.querySelector(`[data-box-id="${id}"]`));
}

function updateSealUI(box) {
  const sealed = !!box?.sealed;
  if (elSeal) elSeal.textContent = sealed ? '开启' : '封存';
  if (elSealBanner) elSealBanner.hidden = !sealed;
  elTitle.disabled = sealed;
  // Lock editing while sealed, but allow scrolling chat.
  elInput.disabled = sealed || isSending;
  if (elAttach) elAttach.disabled = sealed || isSending;
  // Allow stop when sending, otherwise lock send in sealed mode.
  if (sealed && !isSending) elSend.disabled = true;
  if (!sealed && !isSending) elSend.disabled = false;
}

function runBoxRitual(boxId, type) {
  const el = getBoxEl(boxId);
  if (!el) return;
  const cls = type === 'open' ? 'ritual-open' : 'ritual-seal';
  el.classList.remove('ritual-open', 'ritual-seal');
  // Force reflow to restart animation
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add(cls);

  const sticker = document.createElement('div');
  sticker.className = 'ritual-sticker';
  sticker.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l1.6 4.9L19 8.5l-4.3 2.9 1.6 5-4.3-3-4.3 3 1.6-5L5 8.5l5.4-1.6L12 2z"/>
    </svg>
    <span class="txt">${type === 'open' ? '归来' : '完成'}</span>
  `;
  el.appendChild(sticker);
  setTimeout(() => sticker.remove(), 1300);
  setTimeout(() => el.classList.remove(cls), 900);
}

function runScrollSealRitual() {
  if (!elPaper) return;
  elPaper.classList.remove('ritual-seal-scroll');
  // eslint-disable-next-line no-unused-expressions
  elPaper.offsetHeight;
  elPaper.classList.add('ritual-seal-scroll');

  // confetti burst (🎉)
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  layer.innerHTML = `
    <div class="confetti c1">🎉</div>
    <div class="confetti c2">🎉</div>
    <div class="confetti c3">🎉</div>
    <div class="confetti c4">🎉</div>
    <div class="confetti c5">🎉</div>
  `;
  elPaper.appendChild(layer);
  setTimeout(() => layer.remove(), 1300);
  setTimeout(() => elPaper.classList.remove('ritual-seal-scroll'), 950);
}

let drag = null;
function startDrag(e, boxId) {
  // ignore right click
  if (e.button !== 0) return;
  e.preventDefault();

  const box = getBox(boxId);
  if (!box) return;
  bumpZ(box);
  saveState();

  const el = /** @type {HTMLElement} */ (elCanvas.querySelector(`[data-box-id="${boxId}"]`));
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const shiftX = e.clientX - rect.left;
  const shiftY = e.clientY - rect.top;

  drag = { boxId, shiftX, shiftY };

  const onMove = (ev) => {
    if (!drag) return;
    const b = getBox(drag.boxId);
    if (!b) return;
    const nx = ev.pageX - drag.shiftX;
    const ny = ev.pageY - drag.shiftY;
    b.x = Math.max(0, Math.min(window.innerWidth - 90, nx));
    b.y = Math.max(0, Math.min(window.innerHeight - 90, ny));
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    drag = null;
    saveState();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Scroll UI ---
function openScroll(boxId) {
  const box = getBox(boxId);
  if (!box) return;
  currentBoxId = boxId;
  playOpenSound();

  elTitle.value = box.title || '未命名的记忆';
  renderChat(box);
  updateSealUI(box);

  elOverlay.style.display = 'flex';
  elOverlay.classList.add('open');
  elOverlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    elOverlay.style.opacity = '1';
    scrollChatToBottom();
  });
  setTimeout(() => {
    autosizeInput();
    elInput.focus();
  }, 80);
}

function closeScroll() {
  playCloseSound();
  elOverlay.style.opacity = '0';
  elOverlay.classList.remove('open');
  elOverlay.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    elOverlay.style.display = 'none';
  }, 360);
  currentBoxId = null;
}

function renderChat(box) {
  elChat.innerHTML = '';
  // If empty, seed one gentle greeting (not persisted as "assistant" history)
  if (!box.history.length) {
    const hint = document.createElement('div');
    hint.className = 'message agent';
    hint.textContent = '你好。你可以慢慢写，我在。';
    elChat.appendChild(hint);
  } else {
    for (const m of box.history) {
      const div = document.createElement('div');
      div.className = `message ${m.role === 'user' ? 'user' : 'agent'}`;
      if (m.content) {
        const p = document.createElement('div');
        p.textContent = m.content;
        div.appendChild(p);
      }
      const imgs = Array.isArray(m.imageDataUrls) && m.imageDataUrls.length
        ? m.imageDataUrls
        : (m.imageDataUrl ? [m.imageDataUrl] : []);
      if (imgs.length && m.role === 'user') {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexWrap = 'wrap';
        wrap.style.gap = '10px';
        wrap.style.marginTop = m.content ? '10px' : '0';
        for (const u of imgs.slice(0, MAX_ATTACHMENTS)) {
          const img = document.createElement('img');
          img.src = u;
          img.alt = '用户上传图片';
          img.style.width = '140px';
          img.style.height = '96px';
          img.style.objectFit = 'cover';
          img.style.borderRadius = '12px';
          img.style.boxShadow = '0 14px 30px rgba(0,0,0,0.18)';
          img.loading = 'lazy';
          wrap.appendChild(img);
        }
        div.appendChild(wrap);
      }
      elChat.appendChild(div);
    }
  }
  scrollChatToBottom();
  // If we are currently waiting for agent, keep the typing indicator visible
  if (isSending && currentBoxId === box.id) showTypingIndicator();
}

function toOpenAIContent(msg) {
  const text = String(msg?.content || '');
  const imgs = Array.isArray(msg?.imageDataUrls) && msg.imageDataUrls.length
    ? msg.imageDataUrls
    : (msg?.imageDataUrl ? [msg.imageDataUrl] : []);
  if (imgs.length) {
    const parts = [];
    if (text && text.trim()) parts.push({ type: 'text', text });
    for (const u of imgs.slice(0, MAX_ATTACHMENTS)) {
      parts.push({ type: 'image_url', image_url: { url: u } });
    }
    return parts;
  }
  return text;
}

function isDefaultTitle(title) {
  const t = (title || '').trim();
  return !t || ['记忆盒子', '新记忆...', '未命名的记忆'].includes(t);
}

function tokenizeZh(text) {
  const cleaned = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[0-9A-Za-z_]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()【】[\]{}<>《》—…·.,!?;:'"\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const stop = new Set([
    '然后','但是','因为','所以','如果','就是','其实','真的','感觉','觉得','最近','现在','今天','一个','一些','我们','你们','他们','她们','它们','自己',
    '可能','好像','有点','非常','不是','没有','还是','一直','已经','可以','时候','这里','这样','那样'
  ]);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    const out = [];
    for (const part of seg.segment(cleaned)) {
      const w = part.segment.trim();
      if (!w) continue;
      if (w.length < 2) continue;
      if (stop.has(w)) continue;
      out.push(w);
    }
    return out;
  }
  return cleaned.split(' ').map(s => s.trim()).filter(w => w.length >= 2 && !stop.has(w));
}

function summarizeTitleFromBox(box) {
  const recent = box.history.filter(m => m.role === 'user').slice(-6).map(m => m.content).join(' ');
  const tokens = tokenizeZh(recent);
  if (!tokens.length) return '记忆碎片';
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const sorted = [...freq.entries()].sort((a,b)=>b[1]-a[1]).map(([t])=>t);
  const t1 = sorted[0] || '';
  const t2 = sorted.find(x => x !== t1) || '';
  let title = t1;
  if (t2 && title.length + 1 + t2.length <= 10) title = `${t1}·${t2}`;
  if (title.length > 12) title = title.slice(0, 12);
  return title || '记忆碎片';
}

// --- Agent calling ---
function normalizeProxyUrlToChatUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  try {
    const u = new URL(input);
    const path = u.pathname.replace(/\/+$/, '');
    // If user pasted /health or root, normalize to /api/chat
    if (!path || path === '/' || path.toLowerCase().endsWith('/health')) {
      u.pathname = '/api/chat';
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return input;
  }
}

function makeHealthUrlFromProxyUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  try {
    const u = new URL(input);
    const path = u.pathname.replace(/\/+$/, '');
    if (path.toLowerCase().endsWith('/api/chat')) {
      u.pathname = path.slice(0, -'/api/chat'.length) + '/health';
    } else {
      u.pathname = '/health';
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // best-effort fallback for non-standard inputs
    return input.replace(/\/api\/chat\/?$/i, '/health');
  }
}

async function callAgent({ system, messages }) {
  const url = normalizeProxyUrlToChatUrl(settings.agentProxyUrl);
  const controller = currentAbort;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages }),
    signal: controller?.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function testAgent() {
  const proxyUrl = settings.agentProxyUrl.trim();
  if (!proxyUrl) throw new Error('请填写代理地址');
  // Try /health if possible
  try {
    const health = makeHealthUrlFromProxyUrl(proxyUrl);
    const r = await fetch(health, { method: 'GET' });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const info = { ok: true, provider: j?.provider || 'health', model: j?.model };
      lastAgentMeta = { provider: info.provider, model: info.model };
      return info;
    }
  } catch {}
  // fallback: quick chat
  const data = await callAgent({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 'hello' }],
  });
  lastAgentMeta = { provider: data?.provider, model: data?.model };
  return { ok: true, provider: data?.provider || 'agent', model: data?.model };
}

function localFallbackReply(userText) {
  const t = (userText || '').trim();
  if (!t) return '我在这里。你可以慢慢写。';
  const prompts = [
    '你更希望先从哪一段开始写：今天发生的事，还是你心里反复出现的那句话？',
    '如果把这件事分成三块：事实、感受、需要，你现在最强的是哪一块？',
    '你希望我更多是倾听，还是一起把它梳理成一个可执行的下一步？',
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

// --- Send message ---
async function sendMessage() {
  // If currently sending, clicking send acts as "stop"
  if (isSending) {
    if (currentAbort) currentAbort.abort();
    return;
  }
  const box = currentBoxId ? getBox(currentBoxId) : null;
  if (!box) return;
  if (box.sealed) return;

  const rawText = elInput.value;
  const text = rawText.trim();
  const imgs = pendingImageDataUrls.slice(0, MAX_ATTACHMENTS);
  if (!text && !imgs.length) return;
  isSending = true;
  currentAbort = new AbortController();
  setSendingUI(true);
  updateSealUI(box);

  // push user message
  box.history.push({ role: 'user', content: text, imageDataUrls: imgs.length ? imgs : undefined, ts: Date.now() });
  box.updatedAt = Date.now();
  elInput.value = '';
  autosizeInput();
  clearAttachments();
  renderChat(box);
  saveState();

  // auto title
  if (isDefaultTitle(elTitle.value)) {
    const autoTitle = summarizeTitleFromBox(box);
    box.title = autoTitle;
    elTitle.value = autoTitle;
    // update label on canvas
    const label = elCanvas.querySelector(`[data-box-id="${box.id}"] .label`);
    if (label) label.textContent = autoTitle;
    saveState();
  }

  // call agent (or fallback)
  let reply = '';
  try {
    setStatus(null, '连接中…');
    showTypingIndicator();
    const data = await callAgent({
      system: SYSTEM_PROMPT,
      messages: box.history.map((m) => ({ role: m.role, content: toOpenAIContent(m) })),
    });
    reply = String(data?.reply || '').trim();
    const tag = [data?.provider, data?.model].filter(Boolean).join(' ');
    setStatus(true, tag ? `在线 · ${tag}` : '在线');
  } catch (e) {
    console.warn(e);
    // If user cancelled, do not fallback; just mark stopped.
    if (e?.name === 'AbortError' || String(e?.message || '').includes('aborted')) {
      reply = '（已停止）';
      setStatus(null, '已停止');
    } else {
      setStatus(false, '离线 · 未连接代理');
      reply = localFallbackReply(text);
    }
  }
  // Important: end "sending" BEFORE rendering the assistant reply.
  // Otherwise renderChat() will re-append the typing indicator.
  isSending = false;
  currentAbort = null;
  setSendingUI(false);
  removeTypingIndicator();
  updateSealUI(box);

  if (reply) {
    box.history.push({ role: 'assistant', content: reply, ts: Date.now() });
    box.updatedAt = Date.now();
    renderChat(box);
    saveState();
  }
}

function toggleSealCurrentMemory() {
  if (isSending) return;
  const box = currentBoxId ? getBox(currentBoxId) : null;
  if (!box) return;
  box.sealed = !box.sealed;
  if (box.sealed) box.sealedAt = Date.now();
  box.updatedAt = Date.now();
  saveState();
  // Update box appearance on canvas
  const el = getBoxEl(box.id);
  if (el) el.classList.toggle('sealed', !!box.sealed);
  updateSealUI(box);
  runBoxRitual(box.id, box.sealed ? 'seal' : 'open');
  if (box.sealed) {
    runScrollSealRitual();
    // auto close the scroll after the ritual finishes
    setTimeout(() => closeScroll(), 880);
  }
}

// --- Events ---
elNewBox.addEventListener('click', () => {
  const x = Math.round(Math.random() * (window.innerWidth - 120) + 20);
  const y = Math.round(Math.random() * (window.innerHeight - 140) + 40);
  state.boxes.push(makeNewBox({ x, y, title: '记忆盒子' }));
  saveState();
  renderBoxes();
});

elClose.addEventListener('click', closeScroll);
elOverlay.addEventListener('click', (e) => {
  if (e.target === elOverlay) closeScroll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && elOverlay.style.display === 'flex') closeScroll();
});

elSend.addEventListener('click', sendMessage);
if (elSeal) elSeal.addEventListener('click', toggleSealCurrentMemory);
if (elAttach) elAttach.addEventListener('click', openFilePicker);
if (elImageInput) elImageInput.addEventListener('change', onPickImage);
elInput.addEventListener('input', autosizeInput);
elInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;
  e.preventDefault();
  if (!isSending) sendMessage();
});

elTitle.addEventListener('input', () => {
  const box = currentBoxId ? getBox(currentBoxId) : null;
  if (!box) return;
  const t = elTitle.value.trim();
  box.title = t || '未命名的记忆';
  box.updatedAt = Date.now();
  const label = elCanvas.querySelector(`[data-box-id="${box.id}"] .label`);
  if (label) label.textContent = box.title;
  saveState();
});

function openSettings() {
  elSettingsOverlay.style.display = 'flex';
  elSettingsOverlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => (elSettingsOverlay.style.opacity = '1'));
  elProxyInput.value = settings.agentProxyUrl;
  setTimeout(() => elProxyInput.focus(), 60);
}
function closeSettings() {
  elSettingsOverlay.style.opacity = '0';
  elSettingsOverlay.setAttribute('aria-hidden', 'true');
  setTimeout(() => (elSettingsOverlay.style.display = 'none'), 250);
}
elSettingsBtn.addEventListener('click', openSettings);
elSettingsClose.addEventListener('click', closeSettings);
elSettingsOverlay.addEventListener('click', (e) => {
  if (e.target === elSettingsOverlay) closeSettings();
});

elProxyInput.addEventListener('change', () => {
  settings.agentProxyUrl = elProxyInput.value.trim() || DEFAULT_PROXY;
  saveSettings(settings);
});

elTestAgent.addEventListener('click', async () => {
  settings.agentProxyUrl = elProxyInput.value.trim() || DEFAULT_PROXY;
  saveSettings(settings);
  try {
    setStatus(null, '测试中…');
    const r = await testAgent();
    setStatus(true, r.model ? `在线 · ${r.model}` : '在线');
    renderAttachmentList();
    closeSettings();
  } catch (e) {
    setStatus(false, '离线 · 代理不可用');
    alert(`测试失败：${String(e?.message || e)}`);
  }
});

// Initial render
renderBoxes();
// Try show status on load (non-blocking)
testAgent()
  .then((r) => {
    setStatus(true, r.model ? `在线 · ${r.model}` : '在线');
    renderAttachmentList();
  })
  .catch(() => setStatus(false, '离线 · 未配置代理'));

