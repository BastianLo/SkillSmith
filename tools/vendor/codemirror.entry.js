// Entry of the CodeMirror 6 bundle for the web view (built by tools/vendor/build.sh).
export { EditorState, EditorSelection, Compartment, StateEffect, StateField } from "@codemirror/state"
export { EditorView, keymap, placeholder, drawSelection, highlightActiveLine, dropCursor, rectangularSelection, ViewPlugin, Decoration, WidgetType, MatchDecorator } from "@codemirror/view"
export { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands"
export { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, defaultHighlightStyle } from "@codemirror/language"
export { markdown, markdownLanguage } from "@codemirror/lang-markdown"
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete"
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search"
export { tags } from "@lezer/highlight"
