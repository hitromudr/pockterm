// Find an image in a paste or a drop.
//
// A pasted screenshot travels in the same DataTransfer as text, so "did the
// user paste an image" is a question about the items, not about the event.
// Text pastes must fall through untouched — they are the common case, and
// the terminal already handles them.

function isImage(f) {
  return !!f && String(f.type || '').startsWith('image/');
}

// pickImages returns every image in a DataTransfer, in the order it carries
// them. A drop from a file manager and a picker's selection both arrive as
// several, and one screenshot is that with a length of one.
//
// `files` wins whole when it holds any image: the same picture is exposed
// through both lists, so collecting from each in turn would attach it twice.
// The items are the fallback because Chrome exposes a *pasted* screenshot only
// there.
export function pickImages(data) {
  if (!data) return [];
  const files = Array.from(data.files || []).filter(isImage);
  if (files.length) return files;
  const out = [];
  for (const it of Array.from(data.items || [])) {
    if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
      const f = it.getAsFile && it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

// imageFiles filters what a file chooser handed over. `accept="image/*"` is a
// hint to the picker and not a promise from it — on Android the gallery is one
// app among several, and a file manager offering "all files" is a tap away.
export function imageFiles(list) {
  return Array.from(list || []).filter(isImage);
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
