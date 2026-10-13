package de.skillsmith.intellij

import com.intellij.execution.ExecutionListener
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key

/**
 * Failing runs (exit ≠ 0) of the Run console go to errorsmith: the error is looked up
 * (known solution as notification) and counted as an occurrence, so errorsmith learns about
 * errors that happen outside of opencode, too.
 */
class RunErrorListener(private val project: Project) : ExecutionListener {
    private val outputs = mutableMapOf<ProcessHandler, StringBuilder>()

    override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
        val buf = StringBuilder()
        outputs[handler] = buf
        handler.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                if (buf.length < 40_000 && outputType != ProcessOutputTypes.SYSTEM) buf.append(event.text)
            }
        })
    }

    override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
        val out = outputs.remove(handler)?.toString() ?: return
        if (exitCode == 0 || out.isBlank()) return
        val text = out.takeLast(12_000)
        background(project) {
            val api = SmithApi.forSettings()
            val r = api.action("error.lookup", mapOf("text" to text, "command" to env.runProfile.name, "source" to "intellij")).getAsJsonObject("data")
            val found = r.getAsJsonArray("found")
            if (found.isEmpty) return@background
            val top = found[0].asJsonObject
            val solution = r.get("solution")?.asString.orEmpty()
            NotificationGroupManager.getInstance().getNotificationGroup("skillsmith")
                .createNotification("Bekannter Fehler: ${top.get("title").asString}", solution.take(600).ifEmpty { "Lösung im Eintrag" }, NotificationType.WARNING)
                .addAction(NotificationAction.createSimple("Öffnen") { runCatching { BrowserUtil.browse(api.webLink("#/eintrag/${top.get("id").asString}")) } })
                .notify(project)
        }
    }
}
