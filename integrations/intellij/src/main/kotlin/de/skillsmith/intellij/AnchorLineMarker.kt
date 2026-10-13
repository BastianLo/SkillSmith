package de.skillsmith.intellij

import com.intellij.codeInsight.daemon.LineMarkerInfo
import com.intellij.codeInsight.daemon.LineMarkerProvider
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.ui.awt.RelativePoint
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import java.awt.event.MouseEvent

/** Anchored knowledge per file path (GET /api/code), refreshed at most every 60 s. */
object AnchorIndex {
    data class Anchored(val id: String, val title: String, val ref: String, val kind: String, val status: String?)

    @Volatile private var files: Map<String, List<Anchored>> = emptyMap()
    @Volatile private var loadedAt = 0L

    fun invalidate() {
        loadedAt = 0
    }

    /** Cached; a refresh runs in the background (never blocks highlighting with network I/O). */
    fun forPath(path: String): List<Anchored> {
        if (System.currentTimeMillis() - loadedAt > 60_000) {
            loadedAt = System.currentTimeMillis()
            ApplicationManager.getApplication().executeOnPooledThread { reload() }
        }
        return files.entries.filter { path.endsWith("/${it.key}") || path == it.key }.flatMap { it.value }
    }

    private fun reload() {
        files = runCatching {
            val json = SmithApi.forSettings().get("code").asJsonObject
            json.getAsJsonArray("files").associate { f ->
                val o = f.asJsonObject
                o.get("path").asString to o.getAsJsonArray("entries").map { e ->
                    val x = e.asJsonObject
                    Anchored(x.get("id").asString, x.get("title").asString, x.get("ref").asString, x.get("kind").asString, x.get("status")?.takeIf { !it.isJsonNull }?.asString)
                }
            }
        }.getOrDefault(files)
    }
}

/**
 * Gutter icon at classes, methods and functions with anchored entries ([[code:Class#method]],
 * [[code:path#member]], a file anchor at the first declaration). A click lists the entries
 * and opens one in the web view. Works for every language with named declarations (PSI).
 */
class AnchorLineMarker : LineMarkerProvider {
    override fun getLineMarkerInfo(element: PsiElement): LineMarkerInfo<*>? {
        val owner = element.parent as? PsiNameIdentifierOwner ?: return null
        if (owner.nameIdentifier != element) return null
        val name = owner.name ?: return null
        val vf = element.containingFile?.virtualFile ?: return null
        val project = element.project
        val base = project.basePath ?: return null
        val rel = VfsUtilCore.getRelativePath(vf, project.baseDir ?: return null) ?: vf.path.removePrefix("$base/")
        val anchored = AnchorIndex.forPath(rel).filter { a ->
            val ref = a.ref
            val member = ref.substringAfter('#', "")
            val head = ref.substringBefore('#')
            when (a.kind) {
                "method" -> member == name
                "class" -> head.substringAfterLast('.') == name || head.substringAfterLast('/') == name
                else -> false
            }
        }
        if (anchored.isEmpty()) return null
        val changed = anchored.any { it.status == "changed" || it.status == "deleted" || it.status == "moved" }
        val icon = if (changed) AllIcons.General.Warning else AllIcons.Nodes.Bookmark
        val tooltip = anchored.joinToString("<br>") { "${it.title}${it.status?.let { s -> " ($s)" } ?: ""}" }
        return LineMarkerInfo(element, element.textRange, icon, { "skillsmith:<br>$tooltip" }, { e: MouseEvent, _ ->
            val step = object : BaseListPopupStep<AnchorIndex.Anchored>("skillsmith", anchored) {
                override fun getTextFor(value: AnchorIndex.Anchored) = "${value.title}${value.status?.let { " – $it" } ?: ""}"
                override fun onChosen(selectedValue: AnchorIndex.Anchored, finalChoice: Boolean): PopupStep<*>? {
                    runCatching { BrowserUtil.browse(SmithApi.forSettings().webLink("#/eintrag/${selectedValue.id}")) }
                    return FINAL_CHOICE
                }
            }
            JBPopupFactory.getInstance().createListPopup(step).show(RelativePoint(e))
        }, GutterIconRenderer.Alignment.LEFT, { "skillsmith" })
    }
}
