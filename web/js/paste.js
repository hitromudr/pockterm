// Find an image in a paste or a drop.
//
// A pasted screenshot travels in the same DataTransfer as text, so "did the
// user paste an image" is a question about the items, not about the event.
// Text pastes must fall through untouched — they are the common case, and
// the terminal already handles them.

function isImage(f) {
  return !!f && String(f.type || '').startsWith('image/');
}

// pickImage returns the first image in a DataTransfer, or null.
export function pickImage(data) {
  if (!data) return null;
  for (const f of Array.from(data.files || [])) {
    if (isImage(f)) return f;
  }
  // Chrome exposes a pasted screenshot through items, not files.
  for (const it of Array.from(data.items || [])) {
    if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
      const f = it.getAsFile && it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// carriesFiles answers the dragover question. During a drag the payload is
// not readable yet — only its types are — so pickImage cannot be used to
// decide whether to accept the drop.
export function carriesFiles(data) {
  return !!data && Array.from(data.types || []).includes('Files');
}

// firstImage picks an image out of what the async clipboard API returns.
// The Paste button uses it: on a phone there is no paste event to hook.
export async function firstImage(items) {
  for (const item of Array.from(items || [])) {
    const type = Array.from(item.types || []).find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob) return blob;
  }
  return null;
}
