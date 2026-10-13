package de.skillsmith.intellij

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.util.PsiTreeUtil
import java.awt.datatransfer.StringSelection

fun notify(project: Project?, text: String, type: NotificationType = NotificationType.INFORMATION) {
    NotificationGroupManager.getInstance().getNotificationGroup("skillsmith").createNotification(text, type).notify(project)
}

/** Background call with a notification for errors. */
fun background(project: Project?, work: () -> Unit) {
    ApplicationManager.getApplication().executeOnPooledThread {
        runCatching(work).onFailure { notify(project, "skillsmith: ${it.message}", NotificationType.ERROR) }
    }
}

/** Code anchor of the selection / caret: [[code:path#member]] or [[code:path#Lx-Ly]] – exact through the PSI. */
fun anchorOf(e: AnActionEvent): String? {
    val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
    val project = e.project ?: return null
    val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return null
    val rel = project.baseDir?.let { VfsUtilCore.getRelativePath(vf, it) } ?: vf.name
    val sel = editor.selectionModel
    val doc = editor.document
    if (sel.hasSelection()) {
        val from = doc.getLineNumber(sel.selectionStart) + 1
        val to = doc.getLineNumber(sel.selectionEnd) + 1
        return "[[code:$rel#L$from-L$to]]"
    }
    val psi = PsiDocumentManager.getInstance(project).getPsiFile(doc) ?: return "[[code:$rel]]"
    val at = psi.findElementAt(editor.caretModel.offset)
    val named = PsiTreeUtil.getParentOfType(at, PsiNameIdentifierOwner::class.java)
    return if (named?.name != null) "[[code:$rel#${named.name}]]" else "[[code:$rel]]"
}

class CopyAnchorAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val anchor = anchorOf(e) ?: return
        CopyPasteManager.getInstance().setContents(StringSelection(anchor))
        notify(e.project, "Code-Anker kopiert: $anchor – im Dokument einfügen, skillsmith verankert ihn beim Speichern.")
    }
}

class SaveAsKnowledgeAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.project
        val code = editor.selectionModel.selectedText ?: return notify(project, "Erst Code markieren.")
        val anchor = anchorOf(e) ?: ""
        val title = Messages.showInputDialog(project, "Titel des Dokuments", "Als Wissen speichern", null) ?: return
        val lang = e.getData(CommonDataKeys.VIRTUAL_FILE)?.extension ?: ""
        background(project) {
            val r = SmithApi.forSettings().action("doc.create", mapOf("title" to title, "body" to "Aus der IDE: $anchor\n\n```$lang\n$code\n```\n", "tags" to listOf("ide")))
            notify(project, r.get("message")?.asString ?: "gespeichert")
        }
    }
}

class InsertSnippetAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.project ?: return
        background(project) {
            val api = SmithApi.forSettings()
            val list = api.get("list", mapOf("kind" to "snippet", "tier" to "active")).asJsonArray.map { it.asJsonObject }
            if (list.isEmpty()) return@background notify(project, "Keine Snippets in der Bibliothek.")
            ApplicationManager.getApplication().invokeLater {
                val step = object : BaseListPopupStep<com.google.gson.JsonObject>("Snippet einfügen", list) {
                    override fun getTextFor(value: com.google.gson.JsonObject) = "${value.get("title").asString} – ${value.get("summary")?.asString ?: ""}"
                    override fun onChosen(selectedValue: com.google.gson.JsonObject, finalChoice: Boolean): PopupStep<*>? {
                        background(project) {
                            val id = selectedValue.get("id").asString
                            val text = api.action("snippet.fill", emptyMap(), id).getAsJsonObject("data").get("text").asString
                            ApplicationManager.getApplication().invokeLater {
                                WriteCommandAction.runWriteCommandAction(project) {
                                    editor.document.insertString(editor.caretModel.offset, text)
                                }
                                if ("\${" in text) notify(project, "Platzhalter \${…} noch ausfüllen.")
                            }
                        }
                        return FINAL_CHOICE
                    }
                }
                JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(editor)
            }
        }
    }
}
