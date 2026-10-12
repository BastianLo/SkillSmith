// Entry of the highlight.js bundle (common languages of a Java/Web developer).
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import groovy from "highlight.js/lib/languages/groovy"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import markdown from "highlight.js/lib/languages/markdown"
import plaintext from "highlight.js/lib/languages/plaintext"
import properties from "highlight.js/lib/languages/properties"
import python from "highlight.js/lib/languages/python"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const langs = { bash, css, diff, dockerfile, groovy, ini, java, javascript, json, kotlin, markdown, plaintext, properties, python, shell, sql, typescript, xml, yaml }
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def)
hljs.registerAliases(["sh", "zsh", "console"], { languageName: "bash" })
hljs.registerAliases(["js", "mjs", "cjs"], { languageName: "javascript" })
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" })
hljs.registerAliases(["html", "pom", "maven"], { languageName: "xml" })
hljs.registerAliases(["yml"], { languageName: "yaml" })
hljs.registerAliases(["py"], { languageName: "python" })
hljs.registerAliases(["db2", "plsql"], { languageName: "sql" })
hljs.registerAliases(["gradle"], { languageName: "groovy" })
hljs.registerAliases(["kt"], { languageName: "kotlin" })
export default hljs
