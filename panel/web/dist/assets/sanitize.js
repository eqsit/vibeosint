// Allowlist sanitation of untrusted Markdown-rendered HTML before React inserts it.
window.vibeSanitize = function(input) {
  const doc = new DOMParser().parseFromString(String(input || ''), 'text/html');
  const allowed = new Set(['P','BR','HR','H1','H2','H3','H4','H5','H6','B','STRONG','I','EM','S','DEL','U','CODE','PRE','BLOCKQUOTE','A','UL','OL','LI','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','IMG','SPAN','DIV','SUP','SUB']);
  const allowedAttrs = new Set(['href','title','alt','src','colspan','rowspan','align']);
  function clean(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) { if (child.nodeType !== 3) child.remove(); continue; }
      const el = child;
      if (!allowed.has(el.tagName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') { el.remove(); continue; }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowedAttrs.has(name)) { el.removeAttribute(attr.name); continue; }
        const value = attr.value.trim();
        if (name === 'href' && !/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value)) el.removeAttribute(attr.name);
        if (name === 'src' && (!/^(https?:\/\/|\/api\/uploads\/)/i.test(value) || el.tagName !== 'IMG')) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') { el.setAttribute('rel', 'noopener noreferrer nofollow'); el.setAttribute('target', '_blank'); }
      clean(el);
    }
  }
  clean(doc.body);
  return doc.body.innerHTML;
};
