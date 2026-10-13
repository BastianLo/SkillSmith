package de.skillsmith.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import java.io.File
import javax.swing.JComponent

/** Where the skillsmith store lives (same resolution as the plugin and the CLI). */
@State(name = "SkillsmithSettings", storages = [Storage("skillsmith.xml")])
class SmithSettings : PersistentStateComponent<SmithSettings.Data> {
    class Data {
        var storeDir: String = ""
    }

    private var data = Data()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    var storeDir: String
        get() = data.storeDir
        set(v) {
            data.storeDir = v
        }

    fun resolvedStoreDir(): String {
        if (storeDir.isNotBlank()) return expand(storeDir)
        System.getenv("SKILLSMITH_STORE_DIR")?.takeIf { it.isNotBlank() }?.let { return expand(it) }
        System.getenv("SKILLSMITH_HOME")?.takeIf { it.isNotBlank() }?.let { return expand(it) }
        val xdg = System.getenv("XDG_DATA_HOME")?.takeIf { it.startsWith("/") } ?: "${System.getProperty("user.home")}/.local/share"
        return File(xdg, "skillsmith").path
    }

    private fun expand(p: String): String = if (p.startsWith("~/")) System.getProperty("user.home") + p.substring(1) else p

    companion object {
        fun get(): SmithSettings = ApplicationManager.getApplication().getService(SmithSettings::class.java)
    }
}

class SmithConfigurable : Configurable {
    private val field = JBTextField()

    override fun getDisplayName(): String = "skillsmith"

    override fun createComponent(): JComponent {
        field.text = SmithSettings.get().storeDir
        field.emptyText.text = SmithSettings.get().resolvedStoreDir()
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Store-Verzeichnis:", field)
            .addComponent(JBLabel("Leer = wie das Plugin (SKILLSMITH_STORE_DIR, SKILLSMITH_HOME, ~/.local/share/skillsmith)."))
            .addComponentFillVertically(javax.swing.JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean = field.text != SmithSettings.get().storeDir

    override fun apply() {
        SmithSettings.get().storeDir = field.text.trim()
        AnchorIndex.invalidate()
    }
}
