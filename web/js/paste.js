// Find the files in a paste or a drop.
//
// A pasted screenshot travels in the same DataTransfer as text, so "did the
// user paste a file" is a question about the items, not about the event.
// Text pastes must fall through untouched — they are the common case, and
// the terminal already handles them.
//
// What is carried is no longer only pictures: a document reaches an agent the
// same way, as a path it can open. So nothing here reads the type any more,
// and the one place that still asks about `image/` is the clipboard API,
// which offers nothing else to ask for.

// pickFiles returns every file in a DataTransfer, in the order it carries
// them. A drop from a file manager and a picker's selection both arrive as
// several, and one screenshot is that with a length of one.
//
// `files` wins whole when it holds anything: the same file is exposed through
// both lists, so collecting from each in turn would attach it twice. The items
// are the fallback because Chrome exposes a *pasted* screenshot only there.
export function pickFiles(data) {
  if (!data) return [];
  const files = Array.from(data.files || []);
  if (files.length) return files;
  const out = [];
  for (const it of Array.from(data.items || [])) {
    // `kind` is what separates a file from the text beside it; the type is
    // not asked, a `.md` and a `.png` being equally something to attach.
    if (it.kind === 'file') {
      const f = it.getAsFile && it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

// chosenFiles is what a file chooser handed over, as a list rather than a
// FileList. Nothing is filtered out: the input carries no `accept`, one button
// taking a screenshot and a spec alike.
export function chosenFiles(list) {
  return Array.from(list || []);
}

// carriesFiles answers the dragover question. During a drag the payload is
// not readable yet — only its types are — so pickFiles cannot be used to
// decide whether to accept the drop.
export function carriesFiles(data) {
  return !!data && Array.from(data.types || []).includes('Files');
}

// firstImage picks an image out of what the async clipboard API returns.
// The Paste button uses it: on a phone there is no paste event to hook.
//
// Images only, and that is the API rather than a choice — a system clipboard
// holds a picture or text, and a document is not something it carries.
export async function firstImage(items) {
  for (const item of Array.from(items || [])) {
    const type = Array.from(item.types || []).find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob) return blob;
  }
  return null;
}
