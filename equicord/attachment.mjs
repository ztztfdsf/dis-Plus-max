import core from './engine.mjs';
import { decodeFile, maxBytes } from './media.mjs';

// Only consider the original of an attachment the host gave this specific message.
export function attachmentSource(a, channel) {
    if (!a || !/^\d+$/.test(a.id) || !/^\d+$/.test(channel) || a.spoiler || a.flags || /^SPOILER_/i.test(a.filename || '') || !/\.png$/i.test(a.filename || '') || !(a.size > 0 && a.size <= maxBytes)) return null;
    try {
        const u = new URL(a.url);
        if (u.origin !== 'https://cdn.discordapp.com' || u.username || u.password || !u.pathname.startsWith(`/attachments/${channel}/${a.id}/`) || u.pathname.split('/').length !== 5) return null;
        return u;
    } catch { return null; }
}

function readError(status) {
    const error = Error(`无法读取附件（HTTP ${status}）`);
    error.retryable = status === 408 || status === 429 || status >= 500;
    return error;
}
const policy = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' };
// Normal PNGs cost a prefix, even if an origin ignores Range. Never buffer an unbounded body.
export async function readCarrier(url, salt, signal, get = fetch) {
    let response = await get(url, { ...policy, signal, headers: { Range: 'bytes=0-127' } });
    if (!response.ok || !response.body) throw readError(response.status);
    const partial = response.status === 206;
    let reader = response.body.getReader(), chunks = [], total = 0;
    async function next() {
        const { value, done } = await reader.read();
        if (!done) { total += value.byteLength; if (total > maxBytes) throw Error('附件超过本地处理上限'); chunks.push(value); }
        return !done;
    }
    try {
        while (total < 128 && await next()) { /* split network chunks */ }
        const prefix = new Uint8Array(Math.min(total, 128)); let pos = 0;
        for (const c of chunks) { const n = Math.min(c.length, prefix.length - pos); prefix.set(c.subarray(0, n), pos); pos += n; if (pos === prefix.length) break; }
        if (!core.pngMarkerPayload(prefix) || core.pngReadMarker(prefix, salt)?.saltOk === false) return null;
        if (partial) {
            await reader.cancel(); reader.releaseLock(); reader = null;
            response = await get(url, { ...policy, signal });
            if (response.status !== 200 || !response.body) throw readError(response.status);
            reader = response.body.getReader(); chunks = []; total = 0;
        }
        while (await next()) { /* bounded above */ }
        return new Blob(chunks, { type: 'image/png' });
    } finally { if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } } }
}

const queue = new Set(); let running = 0;
function pump() {
    while (running < 2 && queue.size) {
        const middle = window.innerHeight / 2;
        const distance = j => Math.abs(j.img.getBoundingClientRect().top - middle);
        const next = [...queue].sort((a, b) => distance(a) - distance(b))[0];
        queue.delete(next); ++running;
        next.run().catch(e => { if (e?.name !== 'AbortError') console.warn('MoeGuard：附件还原失败，保留原图'); }).finally(() => { --running; pump(); });
    }
}
function scrollRoot(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.clientHeight) return p;
    return null;
}
function tileFor(row, u) {
    const matches = [];
    for (const link of row.querySelectorAll('a[href]')) {
        let path; try { const x = new URL(link.href); if (!['https://cdn.discordapp.com','https://media.discordapp.net'].includes(x.origin)) continue; path = x.pathname; } catch { continue; }
        if (path !== u.pathname) continue;
        for (let el = link; el && el !== row; el = el.parentElement) {
            if (el.querySelectorAll('a[href]').length > 1) break;
            const imgs = el.querySelectorAll('img');
            if (imgs.length) { if (imgs.length === 1 && !imgs[0].closest('[class*="spoiler" i],[class*="obscur" i],[data-spoiler],[aria-hidden="true"]')) matches.push(imgs[0]); break; }
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

// Paint on the existing replaced element: its source, intrinsic size, focus target, rounded
// clipping, and layout remain under Discord's control. Only our CSS properties are restored.
function paint(img, src) {
    const css = { 'background-image': `url("${src}")`, 'background-size': 'contain', 'background-position': 'center', 'background-repeat': 'no-repeat', 'object-position': '-100000px -100000px' };
    const restore = [];
    for (const [k, v] of Object.entries(css)) {
        const old = img.style.getPropertyValue(k), priority = img.style.getPropertyPriority(k);
        img.style.setProperty(k, v, 'important'); const owned = img.style.getPropertyValue(k);
        restore.push(() => { if (img.style.getPropertyValue(k) === owned && img.style.getPropertyPriority(k) === 'important') { if (old) img.style.setProperty(k, old, priority); else img.style.removeProperty(k); } });
    }
    return () => restore.forEach(fn => fn());
}

// Called by an Equicord message accessory; no global chat observer and no requests for
// other channels, hidden/spoiler attachments or ordinary thumbnails outside the window.
export function bindAttachment(mark, message, a, salt, onPaint) {
    const url = attachmentSource(a, String(message.channel_id)); if (!url) return () => {};
    const row = mark.closest('[id^="chat-messages-"],[data-list-item-id^="chat-messages___"]');
    const sameRow = () => row && [row.id, row.getAttribute('data-list-item-id') || ''].some(x => x.endsWith('-' + message.id) || x === 'chat-messages___' + message.id);
    if (!sameRow()) return () => {};
    const root = scrollRoot(row); let state, io, stopped = false;
    function clear() {
        if (!state) return;
        const s = state; state = null; queue.delete(s); s.abort.abort(); io?.unobserve(s.img);
        if (s.undo) { s.undo(); onPaint(null); } if (s.object) URL.revokeObjectURL(s.object);
    }
    function sync() {
        const img = sameRow() && tileFor(row, url);
        if (stopped) return;
        if (img && state?.img === img && state.native === img.src) return;
        clear(); if (!img) return;
        const s = { img, native: img.src, abort: new AbortController(), started: false, inside: false, entry: 0, tries: 0, object: null, undo: null };
        const live = () => state === s && img.isConnected && mark.isConnected && sameRow() && tileFor(row, url) === img && img.src === s.native;
        s.run = async () => {
            if (!live() || s.started || !s.inside) return;
            s.started = true; ++s.tries; const entry = s.entry;
            let blob;
            try { blob = await readCarrier(url.href, salt, s.abort.signal); }
            catch (e) {
                if (live() && !s.abort.signal.aborted && s.tries < 3 && (e?.retryable || e instanceof TypeError)) {
                    s.started = false;
                    if (s.inside && s.entry !== entry) queue.add(s);
                }
                throw e;
            }
            if (!blob || !live()) return;
            const out = await decodeFile(blob, salt); if (!live()) return;
            const preview = new Image(); s.object = URL.createObjectURL(out); preview.src = s.object; await preview.decode();
            if (live()) { s.undo = paint(img, s.object); onPaint(s.object); }
        };
        state = s; io.observe(img);
    }
    function measure() {
        io?.disconnect(); io = new IntersectionObserver(entries => {
            for (const it of entries) if (state?.img === it.target && state.inside !== it.isIntersecting) {
                state.inside = it.isIntersecting;
                if (state.inside) { ++state.entry; if (!state.started) queue.add(state); }
                else queue.delete(state);
            }
            pump();
        }, { root, rootMargin: `${2 * (root?.clientHeight || innerHeight)}px 0px` });
        if (state) io.observe(state.img);
    }
    measure(); const resize = new ResizeObserver(measure); resize.observe(root || document.documentElement);
    const mutations = new MutationObserver(sync); mutations.observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','href','id','class','aria-hidden','data-spoiler','data-list-item-id'] }); sync();
    return () => { stopped = true; mutations.disconnect(); resize.disconnect(); io.disconnect(); clear(); };
}
