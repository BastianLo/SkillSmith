package de.skillsmith.intellij

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JPanel

/** Tasks of the current branch, agent jobs, waiting approvals – click opens the web view. */
class SmithToolWindow : ToolWindowFactory {
    data class Row(val text: String, val hash: String) {
        override fun toString() = text
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        for ((title, loader) in listOf<Pair<String, () -> List<Row>>>(
            "Aufgaben" to { tasks(project) },
            "Aufträge" to { jobs() },
            "Freigaben" to { approvals() },
        )) {
            toolWindow.contentManager.addContent(factory.createContent(panel(loader), title, false))
        }
    }

    private fun panel(loader: () -> List<Row>): JPanel {
        val model = DefaultListModel<Row>()
        val list = JBList(model)
        val refresh = {
            ApplicationManager.getApplication().executeOnPooledThread {
                val rows = runCatching(loader).getOrElse { listOf(Row(it.message ?: "Fehler", "")) }
                ApplicationManager.getApplication().invokeLater {
                    model.clear()
                    rows.ifEmpty { listOf(Row("(nichts)", "")) }.forEach(model::addElement)
                }
            }
        }
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount < 2) return
                val row = list.selectedValue ?: return
                if (row.hash.isNotEmpty()) runCatching { BrowserUtil.browse(SmithApi.forSettings().webLink(row.hash)) }
            }
        })
        val p = JPanel(BorderLayout())
        p.add(JButton("Aktualisieren").apply { addActionListener { refresh() } }, BorderLayout.NORTH)
        p.add(JBScrollPane(list), BorderLayout.CENTER)
        refresh()
        return p
    }

    /** Current branch of the project directory (git CLI – no dependency on the Git plugin). */
    private fun branchOf(project: Project): String? = runCatching {
        val p = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD").directory(java.io.File(project.basePath ?: return null)).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText().trim()
        if (p.waitFor() == 0 && out != "HEAD") out else null
    }.getOrNull()

    private fun tasks(project: Project): List<Row> {
        val api = SmithApi.forSettings()
        val branch = branchOf(project)
        val board = api.get("board", mapOf("project" to "*")).asJsonObject
        val cards = board.getAsJsonArray("tasks") ?: return emptyList()
        return cards.map { it.asJsonObject }
            .filter { branch == null || it.get("branch")?.takeIf { b -> !b.isJsonNull }?.asString.let { b -> b == null || b == branch } }
            .map { Row("${it.get("id")?.asString ?: ""} ${it.get("title")?.asString ?: ""} [${it.get("status")?.asString ?: ""}]", "#/aufgabe/${it.get("name")?.asString ?: ""}") }
    }

    private fun jobs(): List<Row> {
        val list = SmithApi.forSettings().get("jobs")
        val arr = if (list.isJsonArray) list.asJsonArray else list.asJsonObject.getAsJsonArray("jobs") ?: return emptyList()
        return arr.map { it.asJsonObject }.map { Row("${it.get("task")?.asString?.uppercase() ?: ""} ${it.get("phase")?.asString ?: ""}${it.get("waitingFor")?.takeIf { w -> !w.isJsonNull }?.let { w -> " – wartet: ${w.asString}" } ?: ""}", "#/agenten/${it.get("id")?.asString ?: ""}") }
    }

    private fun approvals(): List<Row> {
        val inbox = SmithApi.forSettings().get("inbox").asJsonObject
        val wanted = setOf("agent-proposal", "agent-done", "permission", "proposal", "staged", "conflict", "pipeline", "code-changed")
        return inbox.getAsJsonArray("items").map { it.asJsonObject }.filter { it.get("type").asString in wanted }.map { Row("${it.get("group").asString}: ${it.get("title").asString}", "#/eingang") }
    }
}
