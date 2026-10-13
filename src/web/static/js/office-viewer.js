// Office viewers/editors (ooxml by ChristopherVR, Apache-2.0; vendored under /vendor/office,
// loaded only on the office pages). One interface for both:
//   mountOffice(el, { family, bytes, editable, fileName, onDirty }) → { load(bytes), save(), dirty, destroy() }
// save() returns the file as Uint8Array.

let pptxMod
let docxMod

function ensureCss() {
  if (document.getElementById("office-css")) return
  document.head.append(Object.assign(document.createElement("link"), { id: "office-css", rel: "stylesheet", href: "/vendor/office/pptx.css" }))
}

const theme = () => (document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light")

async function toBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  if (x && typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer())
  throw new Error("Die Datei konnte nicht gespeichert werden")
}

async function mountPptx(el, o) {
  ensureCss()
  pptxMod ??= import("/vendor/office/pptx.js")
  const { createPptxViewer, de } = await pptxMod
  let dirty = false
  const viewer = await createPptxViewer(el, {
    fileName: o.fileName,
    editable: !!o.editable,
    readOnly: !o.editable,
    locale: "de",
    messages: { de },
    showInspector: !!o.editable,
    showToolbar: !!o.editable,
    showCompatibilityToasts: false,
    // skillsmith stores the file: no Protected View banner, no autosave into the browser
    customization: { options: { locked: { "trust.openInProtectedView": false, "save.autoSave": false }, hiddenSettings: ["trust.openInProtectedView", "save.autoSave"] } },
    onDirtyChange: (d) => {
      dirty = !!d
      o.onDirty?.(dirty)
    },
  })
  // the file comes from skillsmith, not from the internet: no "Protected View" banner
  await viewer.loadFile(o.bytes, { skipProtectedView: true })
  if (o.editable) {
    try {
      viewer.enableEditingFromProtectedView?.()
    } catch {}
  }
  if (o.slide) viewer.goToSlide(o.slide)
  return {
    get dirty() {
      return dirty
    },
    async load(bytes, keepSlide = true) {
      const at = keepSlide ? viewer.getCurrentSlide?.() ?? 0 : 0
      await viewer.loadFile(bytes, { skipProtectedView: true })
      if (at && viewer.getSlideCount?.() > at) viewer.goToSlide(at)
      else if (keepSlide && viewer.getSlideCount?.() > 0) viewer.goToSlide(Math.min(at, viewer.getSlideCount() - 1))
    },
    /** jump to the last slide (live preview of an AI draft that adds slides) */
    last() {
      const n = viewer.getSlideCount?.() ?? 0
      if (n) viewer.goToSlide(n - 1)
    },
    async save() {
      return toBytes(await viewer.save())
    },
    destroy() {
      try {
        viewer.destroy?.()
      } catch {}
      el.replaceChildren()
    },
  }
}

async function mountDocx(el, o) {
  docxMod ??= import("/vendor/office/docx.js")
  const { mountEditor } = await docxMod
  let dirty = false
  const ed = mountEditor(el, {
    readOnly: !o.editable,
    locale: "de",
    theme: theme(),
    showToolbar: !!o.editable,
    onDirtyChange: (d) => {
      dirty = !!d
      o.onDirty?.(dirty)
    },
  })
  await ed.load(o.bytes)
  return {
    get dirty() {
      return dirty
    },
    async load(bytes) {
      const scroller = el.querySelector("[part=scroller], .scroller") || el
      const top = scroller.scrollTop
      await ed.load(bytes)
      scroller.scrollTop = top
    },
    last() {},
    async save() {
      const out = await toBytes(await ed.save())
      ed.markClean?.()
      return out
    },
    destroy() {
      try {
        ed.destroy?.()
      } catch {}
      el.replaceChildren()
    },
  }
}

export function mountOffice(el, o) {
  return o.family === "pptx" ? mountPptx(el, o) : mountDocx(el, o)
}
