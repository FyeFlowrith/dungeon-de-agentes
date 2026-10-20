// Dungeon de agentes — app nativa de macOS para Claude Code en la terminal.
// Lee los agentes vivos de ~/.claude/sessions/<pid>.json (estado que publica Claude Code) y el título,
// la rama y la herramienta en uso de su transcripción (~/.claude/projects/*/<sessionId>.jsonl), y los
// dibuja en una ventana propia (WebKit, la vista pixel-art de web/). Clic en una tarjeta: trae al frente
// la pestaña de Terminal o iTerm2 donde corre ese agente.
import Cocoa
import WebKit
import ApplicationServices

// MARK: - Lectura de agentes (misma lógica que sesiones.js de la extensión de VS Code)

struct Sesion: Encodable {
    let id: String
    let pid: Int
    let titulo: String
    let branch: String
    let repo: String
    let carpeta: String
    let estado: String
    let detalle: String
    let edadMs: Double
    let nacio: Double
    let heroe: Int
    let enVsCode: Bool
    let pista: String
}

final class Info {
    var titulo = "", branch = "", cwd = "", carpeta = "", entrypoint = ""
    var ultimo: String? = nil // prompt | tool_result | tool_use | end_turn | interrumpido | error
    var pendientes: [(id: String, nombre: String)] = []
    var limitado = false
    var hayAssistant = false
}

final class Lector {
    private let fm = FileManager.default
    private let projects: URL
    private let sessions: URL
    private var cache: [String: (size: UInt64, mtime: Double, info: Info)] = [:]
    private var rutas: [String: String] = [:]

    private let tailBytes: UInt64 = 384 * 1024
    private let headBytes: UInt64 = 64 * 1024
    private let terminoMaxMs: Double = 20 * 60 * 1000
    private let preguntan: Set<String> = ["AskUserQuestion", "ExitPlanMode"]
    private let toolDetalle: [String: String] = [
        "Bash": "corriendo un comando", "Edit": "editando", "Write": "escribiendo", "Read": "leyendo",
        "Grep": "buscando", "Glob": "buscando", "WebFetch": "leyendo la web", "WebSearch": "buscando en la web",
        "Agent": "con subagentes", "Workflow": "con subagentes", "TodoWrite": "planeando",
        "AskUserQuestion": "te hizo una pregunta", "ExitPlanMode": "espera que apruebes el plan", "Artifact": "publicando",
    ]
    private let prioridad: [String: Int] = ["blocked": 0, "limited": 1, "done": 2, "working": 3, "unknown": 4, "idle": 5]

    init() {
        let home = fm.homeDirectoryForCurrentUser
        projects = home.appendingPathComponent(".claude/projects")
        sessions = home.appendingPathComponent(".claude/sessions")
    }

    private func leerTrozo(_ ruta: String, desde: UInt64, largo: UInt64) -> String {
        guard let fh = FileHandle(forReadingAtPath: ruta) else { return "" }
        defer { try? fh.close() }
        try? fh.seek(toOffset: desde)
        let data = (try? fh.read(upToCount: Int(largo))) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private func lineas(_ texto: String, descartarPrimera: Bool) -> [[String: Any]] {
        var ls = texto.split(separator: "\n", omittingEmptySubsequences: true)
        if descartarPrimera, !ls.isEmpty { ls.removeFirst() }
        return ls.compactMap { l in
            (try? JSONSerialization.jsonObject(with: Data(l.utf8))) as? [String: Any]
        }
    }

    private func textoDe(_ content: Any?) -> String {
        if let s = content as? String { return s }
        guard let arr = content as? [[String: Any]] else { return "" }
        return arr.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: " ")
    }

    private func limpiarPrompt(_ t: String) -> String {
        var s = t
        for patron in ["<[^>]+>[\\s\\S]*?</[^>]+>", "<[^>]+>", "\\s+"] {
            s = s.replacingOccurrences(of: patron, with: " ", options: .regularExpression)
        }
        return s.trimmingCharacters(in: .whitespaces)
    }

    private func analizar(_ ruta: String, size: UInt64) -> Info {
        let info = Info()
        let truncado = size > tailBytes
        let desde = size > tailBytes ? size - tailBytes : 0
        var customTitle = "", aiTitle = "", agentName = ""
        for d in lineas(leerTrozo(ruta, desde: desde, largo: min(size, tailBytes)), descartarPrimera: truncado) {
            if let v = d["customTitle"] as? String, !v.isEmpty { customTitle = v }
            if let v = d["aiTitle"] as? String, !v.isEmpty { aiTitle = v }
            if let v = d["agentName"] as? String, !v.isEmpty { agentName = v }
            if let v = d["gitBranch"] as? String, !v.isEmpty { info.branch = v }
            if let v = d["cwd"] as? String, !v.isEmpty { info.cwd = v }
            if let v = d["entrypoint"] as? String, !v.isEmpty { info.entrypoint = v }
            if d["isSidechain"] as? Bool == true { continue }
            let tipo = d["type"] as? String
            let m = d["message"] as? [String: Any] ?? [:]
            if tipo == "assistant" {
                info.hayAssistant = true
                let content = m["content"] as? [[String: Any]] ?? []
                var usaTool = false
                for b in content where b["type"] as? String == "tool_use" {
                    usaTool = true
                    info.pendientes.append((b["id"] as? String ?? "", b["name"] as? String ?? ""))
                }
                let txt = textoDe(content)
                info.limitado = txt.range(of: "hit your (session|usage|weekly)? ?limit|usage limit reached", options: [.regularExpression, .caseInsensitive]) != nil
                let stop = m["stop_reason"] as? String
                if stop == "end_turn" || stop == "stop_sequence" { info.ultimo = "end_turn" } else if usaTool { info.ultimo = "tool_use" }
            } else if tipo == "user", d["isMeta"] as? Bool != true {
                if let c = m["content"] as? [[String: Any]], c.contains(where: { $0["type"] as? String == "tool_result" }) {
                    let hechos = Set(c.filter { $0["type"] as? String == "tool_result" }.compactMap { $0["tool_use_id"] as? String })
                    info.pendientes.removeAll { hechos.contains($0.id) }
                    info.ultimo = "tool_result"
                } else {
                    let t = textoDe(m["content"])
                    if t.contains("[Request interrupted by user") { info.ultimo = "interrumpido"; info.pendientes.removeAll() }
                    else if !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { info.ultimo = "prompt"; info.limitado = false }
                }
            } else if tipo == "system", d["subtype"] as? String == "api_error" {
                info.ultimo = "error"
                if let data = try? JSONSerialization.data(withJSONObject: d), String(decoding: data.prefix(4000), as: UTF8.self).range(of: "limit", options: .caseInsensitive) != nil {
                    info.limitado = true
                }
            }
        }
        // Del principio: la carpeta donde se abrió la sesión y el primer pedido, por si no hay título.
        var carpeta = "", prompt = ""
        for d in lineas(leerTrozo(ruta, desde: 0, largo: min(size, headBytes)), descartarPrimera: false) {
            if carpeta.isEmpty, let v = d["cwd"] as? String { carpeta = v }
            if prompt.isEmpty, d["type"] as? String == "user", d["isMeta"] as? Bool != true, d["isSidechain"] as? Bool != true {
                prompt = limpiarPrompt(textoDe((d["message"] as? [String: Any])?["content"]))
            }
            if !carpeta.isEmpty && !prompt.isEmpty { break }
        }
        info.carpeta = carpeta.isEmpty ? info.cwd : carpeta
        info.titulo = [customTitle, agentName, aiTitle, prompt].first { !$0.isEmpty } ?? ""
        return info
    }

    private func buscarTranscripcion(_ id: String) -> String? {
        if let r = rutas[id], fm.fileExists(atPath: r) { return r }
        guard let dirs = try? fm.contentsOfDirectory(atPath: projects.path) else { return nil }
        for d in dirs {
            let p = projects.appendingPathComponent(d).appendingPathComponent("\(id).jsonl").path
            if fm.fileExists(atPath: p) { rutas[id] = p; return p }
        }
        return nil
    }

    private func infoTranscripcion(_ ruta: String) -> Info? {
        guard let attr = try? fm.attributesOfItem(atPath: ruta),
              let size = (attr[.size] as? NSNumber)?.uint64Value,
              let mtime = (attr[.modificationDate] as? Date)?.timeIntervalSince1970 else { return nil }
        if let c = cache[ruta], c.size == size, c.mtime == mtime { return c.info }
        let info = analizar(ruta, size: size)
        cache[ruta] = (size, mtime, info)
        return info
    }

    private func vivo(_ pid: Int) -> Bool {
        kill(pid_t(pid), 0) == 0 || errno == EPERM
    }

    private func heroe(_ id: String) -> Int {
        var h: Int32 = 0
        for u in id.utf16 { h = h &* 31 &+ Int32(u) }
        return Int(Int64(h).magnitude % 6)
    }

    private func estado(_ p: [String: Any], _ info: Info?, ahora: Double) -> (String, String) {
        let pend = info?.pendientes.map { $0.nombre } ?? []
        if info?.limitado == true { return ("limited", "se quedó sin cuota") }
        let pregunta = pend.first { preguntan.contains($0) }
        let status = p["status"] as? String
        if status == "waiting" || pregunta != nil {
            let waitingFor = p["waitingFor"] as? String
            let detalle = (p["needs"] as? String) ?? pregunta.flatMap { toolDetalle[$0] }
                ?? (waitingFor == "dialog open" ? "espera tu respuesta" : waitingFor) ?? "espera tu respuesta"
            return ("blocked", detalle)
        }
        if status == "busy" {
            let tool = pend.last ?? ""
            return ("working", toolDetalle[tool] ?? (tool.isEmpty ? "pensando" : "usando \(tool)"))
        }
        if status == "idle" {
            let desde = ahora - ((p["statusUpdatedAt"] as? Double) ?? (p["updatedAt"] as? Double) ?? ahora)
            return desde <= terminoMaxMs ? ("done", "te respondió") : ("idle", "esperando")
        }
        return ("unknown", status ?? "")
    }

    /// Los agentes de Claude Code que están corriendo ahora, primero los que te necesitan.
    func leer() -> [Sesion] {
        let ahora = Date().timeIntervalSince1970 * 1000
        guard let archivos = try? fm.contentsOfDirectory(atPath: sessions.path) else { return [] }
        var out: [Sesion] = []
        var vistos = Set<String>()
        for f in archivos where f.range(of: "^\\d+\\.json$", options: .regularExpression) != nil {
            guard let data = fm.contents(atPath: sessions.appendingPathComponent(f).path),
                  let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let sid = p["sessionId"] as? String, let pid = p["pid"] as? Int, vivo(pid) else { continue }
            if let kind = p["kind"] as? String, kind != "interactive" { continue }
            if vistos.contains(sid) { continue }
            vistos.insert(sid)
            let info = buscarTranscripcion(sid).flatMap { infoTranscripcion($0) }
            let (est, detalle) = estado(p, info, ahora: ahora)
            let carpeta = (p["cwd"] as? String) ?? info?.carpeta ?? ""
            let enVsCode = (p["entrypoint"] as? String) == "claude-vscode"
            let ref = (p["statusUpdatedAt"] as? Double) ?? (p["updatedAt"] as? Double) ?? (p["startedAt"] as? Double) ?? ahora
            let titulo = [info?.titulo ?? "", p["name"] as? String ?? ""].first { !$0.isEmpty } ?? "Sesión nueva"
            out.append(Sesion(
                id: sid, pid: pid, titulo: titulo, branch: info?.branch ?? "",
                repo: carpeta.isEmpty ? "" : (carpeta as NSString).lastPathComponent, carpeta: carpeta,
                estado: est, detalle: detalle, edadMs: ahora - ref, nacio: (p["startedAt"] as? Double) ?? 0,
                heroe: heroe(sid), enVsCode: true,
                pista: enVsCode ? "Clic para abrirla en VS Code" : "Clic para ir a su pestaña de la Terminal"))
        }
        let usados = Set(vistos.compactMap { rutas[$0] })
        for k in cache.keys where !usados.contains(k) { cache.removeValue(forKey: k) }
        return out.sorted {
            let (a, b) = (prioridad[$0.estado] ?? 9, prioridad[$1.estado] ?? 9)
            return a != b ? a < b : $0.nacio > $1.nacio
        }
    }

    func esDeVsCode(pid: Int) -> Bool {
        let ruta = sessions.appendingPathComponent("\(pid).json").path
        guard let data = fm.contents(atPath: ruta),
              let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return (p["entrypoint"] as? String) == "claude-vscode"
    }
}

// MARK: - Ir a la pestaña del agente

enum Foco {
    static func correr(_ cmd: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Registro de diagnóstico en ~/Library/Logs/DungeonDeAgentes.log
    static func registrar(_ texto: String) {
        let ruta = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DungeonDeAgentes.log")
        let linea = "\(Date()) \(texto)\n"
        if let fh = try? FileHandle(forWritingTo: ruta) {
            fh.seekToEndOfFile(); fh.write(Data(linea.utf8)); try? fh.close()
        } else {
            try? linea.write(to: ruta, atomically: true, encoding: .utf8)
        }
    }

    // MARK: Accesibilidad: elegir una pestaña en el menú Ventana de la Terminal

    static func atributo(_ e: AXUIElement, _ a: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
    }

    static func hijos(_ e: AXUIElement) -> [AXUIElement] {
        (atributo(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    // Sin el tamaño del final («— 112×29», cambia al agrandar la ventana), sin símbolos (el ✳ / · que
    // Claude Code va cambiando en el título) y sin espacios de más.
    static func normalizar(_ s: String) -> String {
        let sinTamanio = s.replacingOccurrences(of: "\\s*\\d+\\s*[×x]\\s*\\d+\\s*$", with: "", options: .regularExpression)
        let soloLetras = sinTamanio.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
        return String(soloLetras).split(separator: " ").joined(separator: " ").lowercased()
    }

    static func terminalAX() -> AXUIElement? {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").first
            .map { AXUIElementCreateApplication($0.processIdentifier) }
    }

    /// ¿La pestaña que la Terminal tiene al frente tiene esta marca en el título?
    static func terminalMuestra(_ marca: String) -> Bool {
        guard let app = terminalAX(), let ref = atributo(app, kAXFocusedWindowAttribute) else { return false }
        return normalizar(atributo(ref as! AXUIElement, kAXTitleAttribute) as? String ?? "").contains(normalizar(marca))
    }

    /// En la Terminal de macOS las pestañas son pestañas del sistema: cada una es una ventana y
    /// traerla al frente por AppleScript no cambia la pestaña visible. Elegirla en el menú Ventana sí.
    static func elegirEnMenuVentana(_ marca: String) -> Bool {
        guard let app = terminalAX(), let barraRef = atributo(app, kAXMenuBarAttribute) else { return false }
        let buscado = normalizar(marca)
        // De atrás para adelante: el menú Ventana está casi al final de la barra.
        for menuDeLaBarra in hijos(barraRef as! AXUIElement).reversed() {
            for menu in hijos(menuDeLaBarra) {
                for item in hijos(menu) where normalizar(atributo(item, kAXTitleAttribute) as? String ?? "").contains(buscado) {
                    return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
                }
            }
        }
        return false
    }

    static func textoAppleScript(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Trae la pestaña de la Terminal cuya tty es `dev`. Dos agentes en la misma carpeta tienen el mismo
    /// título, así que le pongo a la pestaña un título temporal único, la elijo por ese título en el
    /// menú Ventana y le devuelvo su título. Devuelve nil si salió bien, o el motivo.
    static func irEnTerminal(_ dev: String) -> String? {
        let marca = "dungeon \(dev.replacingOccurrences(of: "/dev/", with: ""))"
        guard let r = correr("/usr/bin/osascript", ["-e", """
            tell application id "com.apple.Terminal"
              repeat with i from 1 to (count of windows)
                repeat with j from 1 to (count of tabs of window i)
                  if tty of tab j of window i is "\(dev)" then
                    set w to window i
                    set t to tab j of w
                    set viejaMuestra to title displays custom title of t
                    set viejoTitulo to custom title of t
                    set custom title of t to "\(marca)"
                    set title displays custom title of t to true
                    set selected of t to true
                    set index of w to 1
                    activate
                    return "ok|" & viejaMuestra & "|" & viejoTitulo
                  end if
                end repeat
              end repeat
            end tell
            return "no"
            """]), r.hasPrefix("ok|") else { return "no" }
        let partes = r.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        let viejaMuestra = partes.count > 1 ? partes[1] : "false"
        let viejoTitulo = partes.count > 2 ? partes[2] : ""
        defer {
            _ = correr("/usr/bin/osascript", ["-e", """
                tell application id "com.apple.Terminal"
                  repeat with i from 1 to (count of windows)
                    repeat with j from 1 to (count of tabs of window i)
                      if tty of tab j of window i is "\(dev)" then
                        set custom title of tab j of window i to \(textoAppleScript(viejoTitulo))
                        set title displays custom title of tab j of window i to \(viejaMuestra == "true" ? "true" : "false")
                        return "ok"
                      end if
                    end repeat
                  end repeat
                end tell
                """])
        }
        guard AXIsProcessTrusted() else {
            let opciones = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opciones)
            registrar("ir \(dev): sin permiso de Accesibilidad")
            return "Para cambiar a la pestaña del agente, macOS necesita que «Dungeon de agentes» tenga permiso de Accesibilidad: activalo en Ajustes del Sistema → Privacidad y seguridad → Accesibilidad y volvé a tocar la tarjeta."
        }
        Thread.sleep(forTimeInterval: 0.15) // que el menú Ventana tome el título nuevo
        if terminalMuestra(marca) { registrar("ir \(dev): ya al frente"); return nil }
        let presionada = elegirEnMenuVentana(marca)
        Thread.sleep(forTimeInterval: 0.3)
        let alFrente = terminalMuestra(marca)
        registrar("ir \(dev): menú=\(presionada ? "ok" : "no") al frente=\(alFrente ? "sí" : "no")")
        return alFrente ? nil : "Encontré la pestaña del agente pero no pude traerla al frente."
    }

    /// Abre la conversación en VS Code, en la ventana de su carpeta. Si está la extensión «Dungeon de
    /// agentes» de VS Code, le dejo el pedido en su archivo compartido (la ventana de esa carpeta lo toma
    /// y abre la pestaña de la sesión) y traigo esa ventana al frente. Si no, uso el link de la extensión
    /// de Claude, que la abre en la ventana de VS Code que esté activa.
    static func irEnVsCode(id: String, carpeta: String) -> String? {
        let fm = FileManager.default
        let dir = fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Code/User/globalStorage/romina-local.dungeon-de-agentes")
        if !carpeta.isEmpty, fm.fileExists(atPath: dir.path), fm.fileExists(atPath: carpeta) {
            let pedido: [String: Any] = ["id": id, "carpeta": carpeta, "ts": Int(Date().timeIntervalSince1970 * 1000)]
            guard let data = try? JSONSerialization.data(withJSONObject: pedido),
                  (try? data.write(to: dir.appendingPathComponent("abrir-sesion.json"), options: .atomic)) != nil else {
                return "No pude pasarle el pedido a VS Code."
            }
            registrar("ir a VS Code: sesión \(id) en \(carpeta)")
            return correr("/usr/bin/open", ["-b", "com.microsoft.VSCode", carpeta]) == nil
                ? "No pude abrir VS Code." : nil
        }
        guard let url = URL(string: "vscode://anthropic.claude-code/open?session=\(id)") else { return "Sesión inválida." }
        registrar("ir a VS Code por link: sesión \(id)")
        return NSWorkspace.shared.open(url) ? nil : "No pude abrir VS Code."
    }

    static func abierta(_ bundleId: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundleId }
    }

    /// Devuelve nil si salió bien, o el motivo para mostrarle a la persona.
    static func ir(pid: Int, id: String, carpeta: String, deVsCode: Bool) -> String? {
        if deVsCode { return irEnVsCode(id: id, carpeta: carpeta) }
        guard let tty = correr("/bin/ps", ["-o", "tty=", "-p", String(pid)]), !tty.isEmpty else {
            return "Ese agente ya no está corriendo."
        }
        if tty.hasPrefix("?") { return "Ese agente no corre en una terminal." }
        let dev = "/dev/\(tty)"
        if abierta("com.googlecode.iterm2"), correr("/usr/bin/osascript", ["-e", """
            tell application id "com.googlecode.iterm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if tty of s is "\(dev)" then
                      select w
                      tell t to select
                      tell s to select
                      activate
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            return "no"
            """]) == "ok" { return nil }
        if abierta("com.apple.Terminal") {
            let motivo = irEnTerminal(dev)
            if motivo != "no" { return motivo }
        }
        return "No encontré la pestaña de ese agente. Si macOS preguntó si «Dungeon de agentes» puede controlar la Terminal, aceptalo (Ajustes del Sistema → Privacidad y seguridad → Automatización)."
    }
}

// MARK: - App

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var ventana: NSWindow!
    var web: WKWebView!
    var item: NSStatusItem!
    let lector = Lector()
    let cola = DispatchQueue(label: "dungeon.lector")
    var ultimas: [Sesion] = []
    var ultimoJson = ""
    var atencionAntes = 0
    // «Siempre visible»: la ventana queda por encima de todo (también de apps a pantalla completa y en
    // todos los escritorios). Se recuerda entre aperturas.
    var siempreVisible = UserDefaults.standard.bool(forKey: "siempreVisible")
    var itemsSiempreVisible: [NSMenuItem] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        armarMenu()
        armarVentana()
        armarBarraDeMenu()
        aplicarSiempreVisible()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refrescar() }
        mostrar()
    }

    func armarVentana() {
        let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let marco = NSRect(x: area.minX, y: area.minY, width: 340, height: area.height)
        ventana = NSWindow(contentRect: marco, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        ventana.title = "Dungeon de agentes"
        ventana.minSize = NSSize(width: 240, height: 300)
        ventana.backgroundColor = NSColor(red: 0x1e / 255, green: 0x1a / 255, blue: 0x17 / 255, alpha: 1)
        ventana.appearance = NSAppearance(named: .darkAqua)
        ventana.isReleasedWhenClosed = false
        ventana.delegate = self
        ventana.setFrameAutosaveName("DungeonDeAgentes") // recuerda dónde la dejaste

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "dungeon")
        web = WKWebView(frame: ventana.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        ventana.contentView!.addSubview(web)
        let dir = Bundle.main.resourceURL!.appendingPathComponent("web")
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
    }

    func armarBarraDeMenu() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(named: "icono") ?? Bundle.main.image(forResource: "icono") {
            img.size = NSSize(width: 18, height: 18)
            item.button?.image = img
        } else {
            item.button?.title = "⚔︎"
        }
        item.button?.toolTip = "Dungeon de agentes"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Mostrar el dungeon", action: #selector(mostrar), keyEquivalent: ""))
        let fijo = NSMenuItem(title: "Siempre visible", action: #selector(alternarSiempreVisible), keyEquivalent: "")
        fijo.target = self
        menu.addItem(fijo)
        itemsSiempreVisible.append(fijo)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Salir", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for m in menu.items where m.action != #selector(alternarSiempreVisible) { m.target = m.action == #selector(mostrar) ? self : nil }
        item.menu = menu
    }

    func armarMenu() {
        let principal = NSMenu()
        let app = NSMenuItem()
        principal.addItem(app)
        let menuApp = NSMenu()
        menuApp.addItem(NSMenuItem(title: "Ocultar Dungeon de agentes", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        menuApp.addItem(.separator())
        menuApp.addItem(NSMenuItem(title: "Salir de Dungeon de agentes", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        app.submenu = menuApp
        let ventanaItem = NSMenuItem()
        principal.addItem(ventanaItem)
        let menuVentana = NSMenu(title: "Ventana")
        menuVentana.addItem(NSMenuItem(title: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        menuVentana.addItem(NSMenuItem(title: "Cerrar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        menuVentana.addItem(.separator())
        let fijo = NSMenuItem(title: "Siempre visible", action: #selector(alternarSiempreVisible), keyEquivalent: "t")
        fijo.keyEquivalentModifierMask = [.command, .shift]
        fijo.target = self
        menuVentana.addItem(fijo)
        itemsSiempreVisible.append(fijo)
        ventanaItem.submenu = menuVentana
        NSApp.mainMenu = principal
        NSApp.windowsMenu = menuVentana
    }

    @objc func alternarSiempreVisible() {
        siempreVisible.toggle()
        UserDefaults.standard.set(siempreVisible, forKey: "siempreVisible")
        aplicarSiempreVisible()
    }

    func aplicarSiempreVisible() {
        ventana.level = siempreVisible ? .floating : .normal
        ventana.collectionBehavior = siempreVisible ? [.canJoinAllSpaces, .fullScreenAuxiliary] : []
        for item in itemsSiempreVisible { item.state = siempreVisible ? .on : .off }
        web.evaluateJavaScript("window.estadoSiempreVisible && window.estadoSiempreVisible(\(siempreVisible))", completionHandler: nil)
    }

    @objc func mostrar() {
        if ventana.isMiniaturized { ventana.deminiaturize(nil) }
        ventana.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Clic en el ícono del Dock: vuelve a mostrar la ventana aunque esté cerrada o minimizada.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mostrar()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // Cerrar la ventana solo la esconde: la app sigue mirando a los agentes (y avisando en el Dock).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        ventana.orderOut(nil)
        return false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ultimoJson = ""
        refrescar()
    }

    func refrescar() {
        cola.async { [weak self] in
            guard let self else { return }
            let sesiones = self.lector.leer()
            let json = (try? JSONEncoder().encode(sesiones)).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
            DispatchQueue.main.async {
                self.ultimas = sesiones
                let atencion = sesiones.filter { $0.estado == "blocked" || $0.estado == "limited" }.count
                NSApp.dockTile.badgeLabel = atencion > 0 ? String(atencion) : nil
                if atencion > self.atencionAntes { NSApp.requestUserAttention(.informationalRequest) }
                self.atencionAntes = atencion
                guard json != self.ultimoJson else { return }
                self.ultimoJson = json
                self.web.evaluateJavaScript("window.recibir(\(json))", completionHandler: nil)
            }
        }
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let msg = message.body as? [String: Any], let tipo = msg["tipo"] as? String else { return }
        if tipo == "listo" { ultimoJson = ""; refrescar(); aplicarSiempreVisible(); return }
        if tipo == "siempreVisible" { alternarSiempreVisible(); return }
        guard tipo == "abrir", let id = msg["id"] as? String, let s = ultimas.first(where: { $0.id == id }) else { return }
        let deVsCode = lector.esDeVsCode(pid: s.pid)
        DispatchQueue.global().async {
            let motivo = Foco.ir(pid: s.pid, id: s.id, carpeta: s.carpeta, deVsCode: deVsCode)
            guard let motivo else { return }
            DispatchQueue.main.async {
                let alerta = NSAlert()
                alerta.messageText = s.titulo
                alerta.informativeText = motivo
                alerta.beginSheetModal(for: self.ventana)
            }
        }
    }
}

// Diagnóstico de cómo ve la Terminal las ventanas y pestañas (corre desde la app, que tiene el permiso).
if CommandLine.arguments.contains("--diag-terminal") {
    let r = Foco.correr("/usr/bin/osascript", ["-e", """
        set salida to ""
        tell application id "com.apple.Terminal"
          set n to count of windows
          set salida to salida & "ventanas=" & n & linefeed
          repeat with i from 1 to n
            set w to window i
            set salida to salida & "ventana " & i & " id=" & (id of w) & " nombre=" & (name of w) & " pestañas=" & (count of tabs of w) & linefeed
            repeat with j from 1 to (count of tabs of w)
              set t to tab j of w
              set salida to salida & "   pestaña " & j & " tty=" & (tty of t) & " sel=" & (selected of t) & " procesos=" & (processes of t as string) & linefeed
            end repeat
          end repeat
        end tell
        return salida
        """]) ?? "(falló osascript)"
    Foco.registrar("DIAGNÓSTICO\n" + r)
    exit(0)
}

// Para diagnosticar sin abrir la ventana: imprime los agentes como JSON y sale.
if CommandLine.arguments.contains("--json") {
    let data = (try? JSONEncoder().encode(Lector().leer())) ?? Data()
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

let app = NSApplication.shared
let delegado = App()
app.delegate = delegado
app.setActivationPolicy(.regular)
app.run()
