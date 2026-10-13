package de.skillsmith.intellij

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
 * Client of the local skillsmith web API. URL and token come from state/web.json of the store
 * (written by the running instance, readable only by the user). Writes go through
 * POST /api/action – the same action catalog, gates and audit as the web view.
 */
class SmithApi(private val storeDir: String) {
    data class Instance(val base: String, val token: String)

    class SmithException(message: String) : Exception(message)

    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()

    fun instance(): Instance {
        val file = File(storeDir, "state/web.json")
        if (!file.isFile) throw SmithException("skillsmith läuft nicht (keine ${file.path}) – skillsmith start oder /smith-web")
        val json = JsonParser.parseString(file.readText()).asJsonObject
        val url = json.get("url")?.asString ?: throw SmithException("web.json ohne url")
        val token = json.get("token")?.asString ?: ""
        return Instance(url.substringBefore("#").trimEnd('/'), token)
    }

    private fun request(path: String): HttpRequest.Builder {
        val i = instance()
        val origin = URI(i.base).let { "${it.scheme}://${it.authority}" }
        return HttpRequest.newBuilder(URI("${i.base}$path"))
            .timeout(Duration.ofSeconds(60))
            .header("x-smith-token", i.token)
            .header("origin", origin)
    }

    private fun send(req: HttpRequest): JsonElement {
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        val body = runCatching { JsonParser.parseString(res.body()) }.getOrNull()
        if (res.statusCode() !in 200..299) {
            val msg = body?.takeIf { it.isJsonObject }?.asJsonObject?.get("error")?.asString ?: "HTTP ${res.statusCode()}"
            throw SmithException(msg)
        }
        return body ?: JsonObject()
    }

    fun get(path: String, query: Map<String, String> = emptyMap()): JsonElement {
        val qs = query.entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, StandardCharsets.UTF_8)}" }
        return send(request("/api/$path${if (qs.isEmpty()) "" else "?$qs"}").GET().build())
    }

    fun action(action: String, args: Map<String, Any?> = emptyMap(), target: String? = null): JsonObject {
        val payload = mutableMapOf<String, Any?>("action" to action, "args" to args.filterValues { it != null })
        if (target != null) payload["target"] = target
        val req = request("/api/action").header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(Gson().toJson(payload))).build()
        return send(req).asJsonObject
    }

    /** Link into the web view (opens in the browser; the token stays in the browser's storage). */
    fun webLink(hash: String): String = "${instance().base}/$hash"

    companion object {
        fun forSettings(): SmithApi = SmithApi(SmithSettings.get().resolvedStoreDir())
    }
}
