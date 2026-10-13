// server side (Bun): read, change and write .pptx/.docx (src/core/office.ts loads this lazily)
export { PptxHandler, Presentation } from "pptx-viewer-core"
export * as automation from "ooxml-core/pptx/automation"
export { loadDocx, saveDocx, createDocument } from "docx-core"
export { default as JSZip } from "jszip"
