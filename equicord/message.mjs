import { attachmentSource, bindAttachment } from './attachment.mjs';

// One badge for one native message row; the rendered image and its link change in
// the same DOM turn. The marker belongs to a mounted MessageAccessoriesAPI component.
export function bindMessage(marker, message, salt) {
    const row = marker.closest('[id^="chat-messages-"],[data-list-item-id^="chat-messages___"]');
    if (!row) return () => {};
    const entries = message.attachments.filter(a => attachmentSource(a, String(message.channel_id)));
    if (!entries.length) return () => {};
    const label = document.createElement('span');
    label.dataset.moeDecoded = 'true'; label.style.cssText = 'position:absolute;z-index:1;display:flex;flex-direction:column;align-items:center;transform:translateX(-50%);font:600 11px/1.2 var(--font-primary,sans-serif);color:var(--text-positive,currentColor)';
    const oldPos = row.style.position; let positioned = false;
    function place() {
        if (!label.isConnected) return;
        const avatar = row.querySelector('img[class*="avatar" i]:not([class*="reply" i]):not([class*="decoration" i])');
        const r = row.getBoundingClientRect(), v = avatar?.getBoundingClientRect();
        label.style.left = `${v?.width ? v.left + v.width / 2 - r.left : Math.min(36, r.width / 8)}px`;
        label.style.top = `${v?.height ? v.bottom - r.top + 2 : 2}px`;
    }
    const links = new Map();
    function render() {
        if (!links.size) { label.remove(); return; }
        if (!label.isConnected) {
            if (getComputedStyle(row).position === 'static') { row.style.position = 'relative'; positioned = true; }
            row.append(label);
        }
        label.replaceChildren(document.createTextNode('已解码'));
        for (const a of entries) if (links.has(a.id)) {
            const link = document.createElement('a'); link.href = links.get(a.id); link.download = a.filename.replace(/\.png$/i, '') + '-decoded.png'; link.textContent = links.size === 1 ? '下载' : `下载 ${entries.indexOf(a) + 1}`;
            link.setAttribute('aria-label',`下载已解码的 ${a.filename}`); link.onclick = e => e.stopPropagation(); label.append(link);
        }
        place();
    }
    const resize = new ResizeObserver(place); resize.observe(row);
    const offs = entries.map(a => bindAttachment(marker, message, a, salt, object => { if (object) links.set(a.id, object); else links.delete(a.id); render(); }));
    return () => { for (const off of offs) off(); resize.disconnect(); label.remove(); if (positioned && row.style.position === 'relative') row.style.position = oldPos; };
}
