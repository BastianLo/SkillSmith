// CodeMirror 6 setup shared by the document editor and the task description:
// Markdown highlighting, [[ link completion (with "create new document"), attachments by
// paste or drop, Ctrl+S save, Ctrl+L link, Ctrl+B/I, search and replace.
import { get, upload } from "./api.js"
import { act, toastError } from "./ui.js"

let cmP = null
export function loadCM() {
  cmP ??= import("../vendor/codemirror.js")
  return cmP
}

/** "[[target]]" for an id: short form for documents, T-12 for tasks. */
export function linkTarget(id) {
  const i = id.indexOf(":")
  const kind = id.slice(0, i)
  const name = id.slice(i + 1)
  return kind === "knowledge" ? name : kind === "task" ? `task:${name.toUpperCase()}` : id
}

export async function createEditor(parent, opts = {}) {
  const cm = await loadCM()
  const { EditorState, EditorView, keymap, placeholder, drawSelection, highlightActiveLine, dropCursor, history, defaultKeymap, historyKeymap, indentWithTab, syntaxHighlighting, HighlightStyle, bracketMatching, markdown, markdownLanguage, autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, search, searchKeymap, highlightSelectionMatches, tags, ViewPlugin, Decoration, MatchDecorator, EditorSelection } = cm

  const style = HighlightStyle.define([
    { tag: tags.heading1, fontWeight: "700", fontSize: "1.25em", color: "var(--text)" },
    { tag: tags.heading2, fontWeight: "700", fontSize: "1.12em", color: "var(--text)" },
    { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "700", color: "var(--text)" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--faint)" },
    { tag: [tags.link, tags.url], color: "var(--accent)" },
    { tag: tags.monospace, color: "var(--k-memory)" },
    { tag: tags.quote, color: "var(--muted)", fontStyle: "italic" },
    { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--faint)" },
    { tag: tags.list, color: "var(--text)" },
    { tag: [tags.keyword, tags.typeName], color: "var(--k-memory)" },
    { tag: [tags.string, tags.inserted], color: "var(--ok)" },
    { tag: [tags.comment], color: "var(--faint)", fontStyle: "italic" },
    { tag: [tags.number, tags.atom], color: "var(--warn)" },
  ])

  // [[links]] and T-12 highlighted
  const linkMarks = new MatchDecorator({ regexp: /\[\[[^\]\n]+\]\]|\bT-\d+\b/g, decoration: Decoration.mark({ class: "cm-wl" }) })
  const linkPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = linkMarks.createDeco(view)
      }
      update(u) {
        this.decorations = linkMarks.updateDeco(u, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  )

  const linkCompletion = async (context) => {
    const m = context.matchBefore(/\[\[[^\]\n|#]*$/)
    if (!m) return null
    const q = m.text.slice(2)
    let items = []
    try {
      items = await get("links/complete", { q, limit: 25 })
    } catch (_) {
      items = []
    }
    const insert = (view, from, to, target) => {
      const after = view.state.sliceDoc(to, to + 2)
      const end = after === "]]" ? to + 2 : after.startsWith("]") ? to + 1 : to
      const text = `${target}]]`
      view.dispatch({ changes: { from, to: end, insert: text }, selection: EditorSelection.cursor(from + text.length) })
      opts.onLinkInserted?.(target)
    }
    const options = items.map((x) => ({
      label: x.title,
      detail: `${x.label} · ${x.id}`,
      type: x.kind === "knowledge" ? "text" : "keyword",
      apply: (view, _c, from, to) => insert(view, from, to, linkTarget(x.id)),
    }))
    if (q.trim().length >= 2 && !opts.noCreate)
      options.push({
        label: `„${q.trim()}“ als neues Dokument anlegen`,
        detail: "neu",
        type: "class",
        boost: -99,
        apply: async (view, _c, from, to) => {
          const r = await act("doc.create", { title: q.trim(), folder: opts.folder || undefined }, { noUndo: true })
          if (r?.target) insert(view, from, to, linkTarget(r.target))
        },
      })
    return { from: m.from + 2, options, filter: false }
  }

  const wrap = (view, mark) => {
    const r = view.state.selection.main
    const text = view.state.sliceDoc(r.from, r.to)
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `${mark}${text}${mark}` }, selection: EditorSelection.range(r.from + mark.length, r.to + mark.length) })
    return true
  }

  const uploadFiles = async (view, files, pos) => {
    for (const f of files) {
      try {
        const r = await upload(f, opts.uploadTarget)
        const md = r.data?.markdown
        if (!md) continue
        const at = pos ?? view.state.selection.main.head
        view.dispatch({ changes: { from: at, insert: `${md}\n` } })
        opts.onUploaded?.(r)
      } catch (err) {
        toastError(err)
      }
    }
  }

  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(style),
    linkPlugin,
    autocompletion({ override: [linkCompletion], activateOnTyping: true, icons: false }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (opts.onSave?.(), true) },
      {
        key: "Mod-l",
        preventDefault: true,
        run: (view) => {
          const r = view.state.selection.main
          const text = view.state.sliceDoc(r.from, r.to)
          view.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}` }, selection: EditorSelection.cursor(r.from + 2 + text.length) })
          startCompletion(view)
          return true
        },
      },
      { key: "Mod-b", run: (v) => wrap(v, "**") },
      { key: "Mod-i", run: (v) => wrap(v, "*") },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange?.(u.state.doc.toString())
      if (u.selectionSet) opts.onCursor?.(u.state.doc.lineAt(u.state.selection.main.head).number)
    }),
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = [...(e.clipboardData?.files || [])]
        if (!files.length) return false
        e.preventDefault()
        uploadFiles(view, files)
        return true
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files || [])]
        if (!files.length) return false
        e.preventDefault()
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined
        uploadFiles(view, files, pos)
        return true
      },
      scroll() {
        opts.onScroll?.()
      },
    }),
    EditorView.theme({ ".cm-wl": { color: "var(--accent)" } }),
  ]
  if (opts.placeholder) extensions.push(placeholder(opts.placeholder))
  if (opts.readOnly) extensions.push(EditorState.readOnly.of(true))
  const view = new EditorView({ state: EditorState.create({ doc: opts.doc ?? "", extensions }), parent })
  return {
    view,
    get value() {
      return view.state.doc.toString()
    },
    set(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    insert(text) {
      const r = view.state.selection.main
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: EditorSelection.cursor(r.from + text.length) })
      view.focus()
    },
    focus: () => view.focus(),
    upload: (files) => uploadFiles(view, files),
    gotoLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, n + 1)))
      view.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 20 }) })
      view.focus()
    },
    link() {
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: "[[" }, selection: EditorSelection.cursor(view.state.selection.main.head + 2) })
      view.focus()
      startCompletion(view)
    },
    scrollRatio() {
      const s = view.scrollDOM
      return s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight)
    },
    destroy: () => view.destroy(),
  }
}
