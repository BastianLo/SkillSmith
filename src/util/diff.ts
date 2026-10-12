/**
 * Line diffs (Myers, O((N+M)·D)) and unified-diff parsing – used for version
 * diffs, previews before saving, conflict (409) answers and AI proposals.
 */

export type DiffOp = { type: "eq" | "add" | "del"; text: string; oldNo?: number; newNo?: number }

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header?: string
  lines: DiffOp[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: "added" | "deleted" | "modified" | "renamed" | "binary"
  hunks: Hunk[]
  additions: number
  deletions: number
}

const splitLines = (s: string): string[] => {
  if (!s) return []
  const lines = s.replace(/\r\n/g, "\n").split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Myers diff of two line arrays. Falls back to a coarse replace for very large inputs. */
export function diffLines(oldText: string | string[], newText: string | string[], maxCost = 20_000_000): DiffOp[] {
  const a = Array.isArray(oldText) ? oldText : splitLines(oldText)
  const b = Array.isArray(newText) ? newText : splitLines(newText)
  // trim common prefix / suffix
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffOp[] = []
  for (let i = 0; i < start; i++) out.push({ type: "eq", text: a[i], oldNo: i + 1, newNo: i + 1 })
  const A = a.slice(start, endA)
  const B = b.slice(start, endB)
  const mid = (A.length + 1) * (B.length + 1) > maxCost ? coarse(A, B) : myers(A, B)
  let oi = start
  let ni = start
  for (const op of mid) {
    if (op.type === "eq") out.push({ type: "eq", text: op.text, oldNo: ++oi, newNo: ++ni })
    else if (op.type === "del") out.push({ type: "del", text: op.text, oldNo: ++oi })
    else out.push({ type: "add", text: op.text, newNo: ++ni })
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ type: "eq", text: a[i], oldNo: i + 1, newNo: j + 1 })
  return out
}

function coarse(a: string[], b: string[]): DiffOp[] {
  return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))]
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (!n) return b.map((text) => ({ type: "add" as const, text }))
  if (!m) return a.map((text) => ({ type: "del" as const, text }))
  const max = n + m
  const offset = max
  let v: Int32Array = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) break outer
    }
  }
  // backtrack
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = v[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: "eq", text: a[x - 1] })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "add", text: b[y - 1] })
      else ops.push({ type: "del", text: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/** Group a full diff into hunks with `context` unchanged lines around changes. */
export function toHunks(ops: DiffOp[], context = 3): Hunk[] {
  const hunks: Hunk[] = []
  const changed = ops.map((o) => o.type !== "eq")
  let i = 0
  while (i < ops.length) {
    if (!changed[i]) {
      i++
      continue
    }
    let startIdx = Math.max(0, i - context)
    // extend while changes are close
    let end = i
    while (end < ops.length) {
      if (changed[end]) {
        end++
        continue
      }
      let j = end
      while (j < ops.length && !changed[j] && j - end < 2 * context) j++
      if (j < ops.length && changed[j] && j - end < 2 * context) {
        end = j
        continue
      }
      break
    }
    const stop = Math.min(ops.length, end + context)
    // keep hunks apart
    if (hunks.length) {
      const last = hunks[hunks.length - 1] as Hunk & { _end: number }
      if (startIdx < last._end) startIdx = last._end
    }
    const lines = ops.slice(startIdx, stop)
    const firstOld = lines.find((l) => l.oldNo !== undefined)?.oldNo ?? 0
    const firstNew = lines.find((l) => l.newNo !== undefined)?.newNo ?? 0
    const h = {
      oldStart: firstOld,
      oldLines: lines.filter((l) => l.type !== "add").length,
      newStart: firstNew,
      newLines: lines.filter((l) => l.type !== "del").length,
      lines,
      _end: stop,
    }
    hunks.push(h)
    i = stop
  }
  return hunks.map(({ _end, ...h }: any) => h as Hunk)
}

export function diffStats(ops: DiffOp[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const o of ops) {
    if (o.type === "add") additions++
    else if (o.type === "del") deletions++
  }
  return { additions, deletions }
}

/** Unified diff text (git diff output) → files with hunks. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | undefined
  let hunk: Hunk | undefined
  let oldNo = 0
  let newNo = 0
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      cur = { path: m?.[2] ?? "", oldPath: m?.[1], status: "modified", hunks: [], additions: 0, deletions: 0 }
      if (cur.oldPath === cur.path) delete cur.oldPath
      files.push(cur)
      hunk = undefined
      continue
    }
    if (!cur) continue
    if (line.startsWith("new file mode")) cur.status = "added"
    else if (line.startsWith("deleted file mode")) cur.status = "deleted"
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed"
      cur.oldPath = line.slice(12)
    } else if (line.startsWith("rename to ")) cur.path = line.slice(10)
    else if (line.startsWith("Binary files ")) cur.status = "binary"
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
      if (!m) continue
      hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), header: m[5] || undefined, lines: [] }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      cur.hunks.push(hunk)
    } else if (hunk) {
      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        hunk.lines.push({ type: "add", text: line.slice(1), newNo: newNo++ })
        cur.additions++
      } else if (line.startsWith("-") && !line.startsWith("--- ")) {
        hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++ })
        cur.deletions++
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ type: "eq", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
      }
    }
  }
  return files
}

/** Unified text of a line diff (previews in commands and logs). */
export function unifiedText(ops: DiffOp[], context = 3): string {
  return toHunks(ops, context)
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`)].join("\n"))
    .join("\n")
}
