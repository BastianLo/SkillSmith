// Diff rendering: hunks from the server (line diff), word marks computed here (LCS over words),
// unified or side by side, inline review findings; entry diffs with fields and meta in words.
import { h, storeGet, storeSet, swap } from "./dom.js"

const tokenize = (s) => String(s).match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []

/** Word-level diff of two lines → [oldHtmlParts, newHtmlParts] as DOM fragments. */
function wordDiff(a, b) {
  const x = tokenize(a)
  const y = tokenize(b)
  if (x.length * y.length > 250_000) return [document.createTextNode(a), document.createTextNode(b)]
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const left = document.createDocumentFragment()
  const right = document.createDocumentFragment()
  let i = 0
  let j = 0
  const push = (frag, tag, text) => {
    if (!text) return
    const last = frag.lastChild
    if (tag && last && last.nodeName.toLowerCase() === tag) last.textContent += text
    else if (!tag && last && last.nodeType === 3) last.textContent += text
    else frag.append(tag ? Object.assign(document.createElement(tag), { textContent: text }) : document.createTextNode(text))
  }
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push(left, null, x[i])
      push(right, null, y[j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(left, "del", x[i++])
    else push(right, "ins", y[j++])
  }
  while (i < n) push(left, "del", x[i++])
  while (j < m) push(right, "ins", y[j++])
  return [left, right]
}

/** Pair del/add runs of a hunk for word marks. */
function pairRuns(lines) {
  const out = []
  let k = 0
  while (k < lines.length) {
    if (lines[k].type === "eq") {
      out.push({ eq: lines[k] })
      k++
      continue
    }
    const dels = []
    const adds = []
    while (k < lines.length && lines[k].type === "del") dels.push(lines[k++])
    while (k < lines.length && lines[k].type === "add") adds.push(lines[k++])
    out.push({ dels, adds })
  }
  return out
}

function findingRow(f, cols) {
  return h("tr", { class: `finding ${f.severity}` }, h("td", { colspan: String(cols) }, `${f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "ℹ️"} ${f.source === "ai" ? "Review" : "Prüfung"}: ${f.text}`))
}

/** Render hunks (unified or split). findings: [{line, ...}] by new line number. */
export function renderHunks(hunks, { mode = "unified", findings = [] } = {}) {
  const byLine = new Map()
  for (const f of findings) if (f.line) (byLine.get(f.line) ?? byLine.set(f.line, []).get(f.line)).push(f)
  const cols = mode === "split" ? 6 : 4
  const widths = mode === "split" ? ["46px", "16px", "", "46px", "16px", ""] : ["46px", "46px", "16px", ""]
  const table = h("table", null, h("colgroup", null, widths.map((w) => h("col", { style: w ? { width: w } : undefined }))))
  const tbody = h("tbody")
  table.append(tbody)
  const addFindings = (no) => {
    for (const f of byLine.get(no) ?? []) tbody.append(findingRow(f, cols))
    byLine.delete(no)
  }
  for (const hunk of hunks) {
    tbody.append(h("tr", { class: "hunk" }, h("td", { colspan: String(cols), text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ""}` })))
    for (const run of pairRuns(hunk.lines)) {
      if (run.eq) {
        const l = run.eq
        if (mode === "split") tbody.append(h("tr", null, h("td", { class: "no", text: l.oldNo ?? "" }), h("td", { class: "sign" }), h("td", { text: l.text }), h("td", { class: "no", text: l.newNo ?? "" }), h("td", { class: "sign" }), h("td", { text: l.text })))
        else tbody.append(h("tr", null, h("td", { class: "no", text: l.oldNo ?? "" }), h("td", { class: "no", text: l.newNo ?? "" }), h("td", { class: "sign", text: " " }), h("td", { text: l.text })))
        if (l.newNo) addFindings(l.newNo)
        continue
      }
      const { dels, adds } = run
      const pairs = Math.min(dels.length, adds.length)
      const marks = []
      for (let p = 0; p < pairs; p++) marks.push(dels.length === adds.length || pairs === 1 ? wordDiff(dels[p].text, adds[p].text) : null)
      if (mode === "split") {
        const rows = Math.max(dels.length, adds.length)
        for (let r = 0; r < rows; r++) {
          const d = dels[r]
          const a = adds[r]
          const wm = marks[r]
          tbody.append(
            h(
              "tr",
              null,
              h("td", { class: "no", text: d?.oldNo ?? "" }),
              h("td", { class: `sign ${d ? "del" : "empty"}`, text: d ? "−" : "" }),
              h("td", { class: d ? "del" : "empty" }, d ? (wm ? wm[0] : d.text) : ""),
              h("td", { class: "no", text: a?.newNo ?? "" }),
              h("td", { class: `sign ${a ? "add" : "empty"}`, text: a ? "+" : "" }),
              h("td", { class: a ? "add" : "empty" }, a ? (wm ? wm[1] : a.text) : ""),
            ),
          )
          if (a?.newNo) addFindings(a.newNo)
        }
      } else {
        dels.forEach((d, p) => tbody.append(h("tr", { class: "del" }, h("td", { class: "no", text: d.oldNo ?? "" }), h("td", { class: "no" }), h("td", { class: "sign", text: "−" }), h("td", null, marks[p] ? marks[p][0] : d.text))))
        adds.forEach((a, p) => {
          tbody.append(h("tr", { class: "add" }, h("td", { class: "no" }), h("td", { class: "no", text: a.newNo ?? "" }), h("td", { class: "sign", text: "+" }), h("td", null, marks[p] ? marks[p][1] : a.text)))
          if (a.newNo) addFindings(a.newNo)
        })
      }
    }
  }
  // findings that are not on a shown line
  for (const list of byLine.values()) for (const f of list) tbody.append(findingRow({ ...f, text: `Zeile ${f.line}: ${f.text}` }, cols))
  return table
}

function modeToggle(onChange) {
  const mode = storeGet("diffMode", "unified")
  const wrap = h("div", { class: "seg" })
  for (const [m, label] of [
    ["unified", "untereinander"],
    ["split", "nebeneinander"],
  ]) {
    wrap.append(
      h("button", {
        type: "button",
        class: m === mode ? "on" : "",
        text: label,
        onclick: () => {
          storeSet("diffMode", m)
          for (const b of wrap.children) b.classList.toggle("on", b.textContent === label)
          onChange(m)
        },
      }),
    )
  }
  return wrap
}

/** One diff box (file or body) with its own mode toggle. */
export function diffBox(title, hunks, extra = {}) {
  const box = h("div", { class: `diff ${storeGet("diffMode", "unified") === "split" ? "split" : ""}` })
  const body = h("div")
  const draw = (mode) => {
    box.classList.toggle("split", mode === "split")
    swap(body, hunks.length ? renderHunks(hunks, { mode, findings: extra.findings }) : h("div", { class: "faint", style: { padding: "8px 10px", fontFamily: "var(--sans)" }, text: extra.empty || "Keine Änderung." }))
  }
  box.append(h("div", { class: "diff-head" }, h("span", { class: "path grow", text: title }), extra.stats ? h("span", { class: "faint", text: extra.stats }) : null, extra.badge || null, modeToggle(draw)), body)
  draw(storeGet("diffMode", "unified"))
  return box
}

const stat = (a, d) => `+${a ?? 0} −${d ?? 0}`

/** Entry diff from the server (fields, body, meta in words, files, test status, raw). */
export function renderEntryDiff(d) {
  const out = h("div", { class: "stack" })
  if (!d) return out
  if (d.fields?.length) {
    out.append(
      h(
        "table",
        { class: "field-changes" },
        h(
          "tbody",
          null,
          d.fields.map((f) =>
            h(
              "tr",
              null,
              h("td", { text: f.label || f.field }),
              h(
                "td",
                null,
                f.added || f.removed
                  ? h("div", { class: "chips" }, (f.removed || []).map((t) => h("span", { class: "chip danger", text: `− ${t}` })), (f.added || []).map((t) => h("span", { class: "chip ok", text: `+ ${t}` })))
                  : [f.before ? h("div", { class: "before", text: f.before }) : null, f.after ? h("div", { class: "after", text: f.after }) : h("div", { class: "faint", text: "(leer)" })],
              ),
            ),
          ),
        ),
      ),
    )
  }
  if (d.body && (d.body.hunks?.length || !d.files?.length)) out.append(diffBox("Inhalt", d.body.hunks || [], { stats: stat(d.body.additions, d.body.deletions), empty: "Inhalt unverändert." }))
  if (d.body?.truncated) out.append(h("div", { class: "notice warn", text: "Der Diff ist gekürzt (web.diffMaxLines)." }))
  for (const f of d.files || []) out.append(diffBox(`${f.path}${f.status && f.status !== "modified" ? ` (${f.status})` : ""}`, f.hunks || [], { stats: stat(f.additions, f.deletions) }))
  if (d.test && (d.test.before || d.test.after)) out.append(h("div", { class: "notice" }, "Teststatus: ", h("strong", { text: d.test.before || "–" }), " → ", h("strong", { text: d.test.after || "–" })))
  if (d.meta?.length) out.append(h("div", null, h("h3", { text: "Metadaten" }), h("ul", { class: "meta-lines" }, d.meta.map((m) => h("li", { text: m })))))
  if (d.raw?.length) {
    const raw = h("details", null, h("summary", { class: "faint", text: "Roh-Diff (git)" }))
    raw.addEventListener("toggle", () => {
      if (raw.open && raw.children.length === 1) for (const f of d.raw) raw.append(diffBox(f.path, f.hunks || [], { stats: stat(f.additions, f.deletions) }))
    })
    out.append(raw)
  }
  if (!d.fields?.length && !(d.body?.hunks?.length) && !d.files?.length && !d.meta?.length) out.append(h("div", { class: "faint", text: "Keine Unterschiede." }))
  return out
}

/** File diffs (agent jobs, previews) with review findings per file and line. */
export function renderFileDiffs(files, findings = []) {
  const out = h("div", { class: "stack" })
  if (!files?.length) return h("div", { class: "faint", text: "Keine Änderungen." })
  const loose = findings.filter((f) => !f.file || !files.some((x) => x.path === f.file))
  if (loose.length) out.append(h("div", { class: "notice warn" }, h("strong", { text: "Befunde ohne Zeile" }), h("ul", { class: "meta-lines" }, loose.map((f) => h("li", { text: `${f.file ? `${f.file}: ` : ""}${f.text}` })))))
  for (const f of files) {
    const own = findings.filter((x) => x.file === f.path)
    out.append(diffBox(`${f.path}${f.status && f.status !== "modified" ? ` (${f.status === "added" ? "neu" : f.status === "deleted" ? "gelöscht" : f.status})` : ""}`, f.hunks || [], { stats: stat(f.additions, f.deletions), findings: own, badge: own.length ? h("span", { class: "chip warn", text: `${own.length} Befund${own.length > 1 ? "e" : ""}` }) : null, empty: f.status === "binary" ? "Binärdatei" : "Keine Textänderung." }))
  }
  return out
}

/** Client-side line diff (proposal adjustments, pipeline command preview). */
export function lineDiff(a, b) {
  const x = String(a ?? "").split("\n")
  const y = String(b ?? "").split("\n")
  const n = x.length
  const m = y.length
  if (n * m > 4_000_000) return [{ oldStart: 1, oldLines: n, newStart: 1, newLines: m, lines: [...x.map((t, i) => ({ type: "del", text: t, oldNo: i + 1 })), ...y.map((t, i) => ({ type: "add", text: t, newNo: i + 1 }))] }]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) ops.push({ type: "eq", text: x[i], oldNo: ++i, newNo: ++j })
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: "del", text: x[i], oldNo: ++i })
    else ops.push({ type: "add", text: y[j], newNo: ++j })
  }
  while (i < n) ops.push({ type: "del", text: x[i], oldNo: ++i })
  while (j < m) ops.push({ type: "add", text: y[j], newNo: ++j })
  // hunks with 3 lines of context
  const hunks = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].type === "eq") {
      k++
      continue
    }
    const start = Math.max(0, k - 3)
    let end = k
    while (end < ops.length) {
      if (ops[end].type !== "eq") {
        end++
        continue
      }
      let e = end
      while (e < ops.length && ops[e].type === "eq") e++
      if (e - end > 6 || e === ops.length) {
        end = Math.min(ops.length, end + 3)
        break
      }
      end = e
    }
    const lines = ops.slice(start, end)
    const first = lines.find((l) => l.oldNo) || { oldNo: 1 }
    const firstNew = lines.find((l) => l.newNo) || { newNo: 1 }
    hunks.push({ oldStart: first.oldNo, oldLines: lines.filter((l) => l.type !== "add").length, newStart: firstNew.newNo, newLines: lines.filter((l) => l.type !== "del").length, lines })
    k = end
  }
  return hunks
}
