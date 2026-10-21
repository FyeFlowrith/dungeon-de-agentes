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
    let costo: Double?     // gasto de la sesión a precio de lista (cost-state de Claude Code)
    let contexto: Int?     // tokens cargados en la última respuesta
    let ventana: Int       // ventana de contexto de la sesión
    let compactaciones: Int // veces que se compactó el contexto de la conversación
    let subagentes: Int    // subagentes trabajando ahora (el slime de la tarjeta)
    let esperandoSubagentes: Bool // Claude ya está libre y solo espera a sus subagentes
    var nivelGasto: Int? = nil // 0 bajo, 1 medio, 2 alto, comparado con el uso de la propia persona
    var pineada = false    // pineada en alguna ventana de VS Code (pid 0: pestaña sin agente corriendo)
}

final class Info {
    var titulo = "", branch = "", cwd = "", carpeta = "", entrypoint = ""
    var ultimo: String? = nil // prompt | tool_result | tool_use | end_turn | interrumpido | error
    var pendientes: [(id: String, nombre: String)] = []
    var limitado = false
    var hayAssistant = false
    var costo: Double? = nil
    var contexto: Int? = nil
    var modelo = ""
    var compactaciones = 0
}

final class Lector {
    private let fm = FileManager.default
    private let projects: URL
    private let sessions: URL
    private var cache: [String: (size: UInt64, mtime: Double, info: Info)] = [:]
    private var rutas: [String: String] = [:]
    private var idPorTitulo: [String: (id: String?, ts: Double)] = [:] // carpeta|título -> sessionId (para no buscar cada 2 s)

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

    // Modelos con ventana de 1 millón de tokens (los demás, 200 mil, salvo que la sesión ya haya pasado ese número).
    private let modelos1M: Set<String> = ["claude-opus-5-5", "claude-fable-5-1"]
    private let chunk: UInt64 = 1024 * 1024

    private func costoDe(_ texto: String) -> Double? {
        var costo: Double? = nil
        for l in texto.split(separator: "\n") where l.contains("\"cost-state\"") {
            if let d = (try? JSONSerialization.jsonObject(with: Data(l.utf8))) as? [String: Any],
               let c = (d["totalCostUSD"] as? NSNumber)?.doubleValue { costo = c }
        }
        return costo
    }

    // El costo lo anota Claude Code de a ratos y puede no estar en el final del archivo: la primera vez se
    // busca hacia atrás; después, solo en lo que se agregó desde la lectura anterior.
    private func ultimoCosto(_ ruta: String, size: UInt64, previo: (size: UInt64, costo: Double?)?) -> Double? {
        if let previo, previo.size <= size {
            return costoDe(leerTrozo(ruta, desde: previo.size, largo: min(size - previo.size, 8 * chunk))) ?? previo.costo
        }
        var fin = size
        while fin > 0 {
            let ini = fin > chunk + 65536 ? fin - chunk - 65536 : 0
            if let c = costoDe(leerTrozo(ruta, desde: ini, largo: fin - ini)) { return c }
            fin = ini
        }
        return nil
    }

    // Cada compactación del contexto deja en la transcripción una línea `"subtype":"compact_boundary"`. Se
    // cuentan sobre los bytes crudos: la primera vez en todo el archivo; después, solo en lo agregado.
    private let marcaCompactacion = Data("\"subtype\":\"compact_boundary\"".utf8)

    private func contarCompactaciones(_ ruta: String, size: UInt64, previo: (size: UInt64, compactaciones: Int)?) -> Int {
        let solape = UInt64(marcaCompactacion.count - 1) // para no perder una marca partida entre dos lecturas
        var desde: UInt64 = 0, n = 0
        if let previo, previo.size <= size { desde = previo.size > solape ? previo.size - solape : 0; n = previo.compactaciones }
        guard let fh = FileHandle(forReadingAtPath: ruta) else { return n }
        defer { try? fh.close() }
        var ini = desde
        while ini < size {
            try? fh.seek(toOffset: ini)
            let trozo = (try? fh.read(upToCount: Int(min(chunk + solape, size - ini)))) ?? Data()
            if trozo.isEmpty { break }
            // Una marca que empieza en el solape se cuenta en la lectura siguiente.
            var rango = trozo.startIndex..<trozo.endIndex
            while let r = trozo.range(of: marcaCompactacion, in: rango), r.lowerBound - trozo.startIndex < Int(chunk) {
                n += 1
                rango = r.lowerBound + 1..<trozo.endIndex
            }
            ini += chunk
        }
        return n
    }

    // ---------- Nivel de gasto: siempre comparado con el uso de la propia persona ----------
    // Con 3 o más sesiones abiertas con gasto, se comparan entre sí (tercios). Con menos, contra las sesiones
    // de la persona en las últimas 2 semanas. Sin historial, sin nivel. El historial se recalcula cada hora.
    private var costoHistorial: [String: (size: UInt64, mtime: Double, costo: Double?)] = [:]
    private var historial: (calculado: Double, costos: [Double]) = (0, [])

    private func costoDesdeElFinal(_ ruta: String, size: UInt64) -> Double? {
        var fin = size, leidos: UInt64 = 0
        while fin > 0 && leidos < 4 * chunk {
            let ini = fin > chunk + 65536 ? fin - chunk - 65536 : 0
            if let c = costoDe(leerTrozo(ruta, desde: ini, largo: fin - ini)) { return c }
            fin = ini; leidos += chunk
        }
        return nil
    }

    func costosDelHistorial() -> [Double] {
        let ahora = Date().timeIntervalSince1970 * 1000
        if ahora - historial.calculado < 3_600_000 { return historial.costos }
        var costos: [Double] = [], vistos = Set<String>()
        for d in (try? fm.contentsOfDirectory(atPath: projects.path)) ?? [] {
            let dir = projects.appendingPathComponent(d)
            for f in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where f.hasSuffix(".jsonl") {
                let ruta = dir.appendingPathComponent(f).path
                guard let attr = try? fm.attributesOfItem(atPath: ruta),
                      let size = (attr[.size] as? NSNumber)?.uint64Value,
                      let mtime = (attr[.modificationDate] as? Date)?.timeIntervalSince1970 else { continue }
                if ahora - mtime * 1000 > 14 * 86_400_000 { continue }
                vistos.insert(ruta)
                var c = costoHistorial[ruta]
                if c == nil || c!.size != size || c!.mtime != mtime {
                    c = (size, mtime, costoDesdeElFinal(ruta, size: size))
                    costoHistorial[ruta] = c
                }
                if let costo = c!.costo, costo >= 0.01 { costos.append(costo) }
            }
        }
        for k in costoHistorial.keys where !vistos.contains(k) { costoHistorial.removeValue(forKey: k) }
        historial = (ahora, costos)
        return costos
    }

    private func asignarNivelesDeGasto(_ sesiones: inout [Sesion]) {
        let conGasto = sesiones.indices.filter { (sesiones[$0].costo ?? 0) >= 0.01 }
        if conGasto.count >= 3 {
            let orden = conGasto.sorted { sesiones[$0].costo! < sesiones[$1].costo! }
            for (i, idx) in orden.enumerated() { sesiones[idx].nivelGasto = min(2, i * 3 / orden.count) }
            return
        }
        let hist = costosDelHistorial()
        guard hist.count >= 3 else { return }
        for idx in conGasto {
            let debajo = Double(hist.filter { $0 < sesiones[idx].costo! }.count) / Double(hist.count)
            sesiones[idx].nivelGasto = debajo < 1.0 / 3 ? 0 : debajo < 2.0 / 3 ? 1 : 2
        }
    }

    // Trabajo en segundo plano: si el agente principal quedó libre pero sus subagentes (o un workflow) siguen
    // escribiendo su transcripción en <transcripción sin .jsonl>/subagents/…, la sesión sigue trabajando.
    func subagentesActivos(_ transcripcion: String, ahora: Double) -> Int {
        let dir = URL(fileURLWithPath: String(transcripcion.dropLast(".jsonl".count)))
        guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: [.contentModificationDateKey],
                                    options: [.skipsHiddenFiles]) else { return 0 }
        var activos = 0
        for case let url as URL in e {
            if e.level > 4 { e.skipDescendants(); continue }
            guard url.pathExtension == "jsonl",
                  let m = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { continue }
            if ahora - m.timeIntervalSince1970 * 1000 <= 45_000 { activos += 1 }
        }
        return activos
    }

    // Comandos que un agente dejó corriendo en segundo plano: cada comando de Claude es una shell hija de su
    // proceso que arranca cargando ~/.claude/shell-snapshots/snapshot-…
    func comandosDeFondoPorPid() -> [Int: Int] {
        guard let salida = Foco.correr("/bin/ps", ["-axo", "pid=,ppid=,args="]) else { return [:] }
        var porPadre: [Int: Int] = [:]
        for l in salida.split(separator: "\n") where l.contains(".claude/shell-snapshots/snapshot-") {
            let campos = l.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            if campos.count >= 2, let padre = Int(campos[1]) { porPadre[padre, default: 0] += 1 }
        }
        return porPadre
    }

    func ventana(_ info: Info?) -> Int {
        guard let info else { return 200_000 }
        if modelos1M.contains(info.modelo) || info.modelo.lowercased().contains("[1m]") || (info.contexto ?? 0) > 200_000 { return 1_000_000 }
        return 200_000
    }

    private func analizar(_ ruta: String, size: UInt64, previo: (size: UInt64, costo: Double?, compactaciones: Int)? = nil) -> Info {
        let info = Info()
        let truncado = size > tailBytes
        let desde = size > tailBytes ? size - tailBytes : 0
        var customTitle = "", aiTitle = "", agentName = ""
        for d in lineas(leerTrozo(ruta, desde: desde, largo: min(size, tailBytes)), descartarPrimera: truncado) {
            if d["type"] as? String == "cost-state", let c = (d["totalCostUSD"] as? NSNumber)?.doubleValue { info.costo = c }
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
                // Contexto usado = lo que el modelo tenía cargado en esta respuesta (nuevo + guardado de antes).
                if let u = m["usage"] as? [String: Any], let modelo = m["model"] as? String, modelo != "<synthetic>" {
                    let n = { (k: String) in (u[k] as? NSNumber)?.intValue ?? 0 }
                    info.contexto = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")
                    info.modelo = modelo
                }
                // El aviso de límite lo escribe Claude Code con el tipo de error marcado; el texto no se mira (un
                // agente que habla de límites no cuenta, y la frase puede cambiar). Ejemplos en pruebas/limite/.
                info.limitado = d["isApiErrorMessage"] as? Bool == true && d["error"] as? String == "rate_limit"
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
                // Es un reintento en curso: si se agotan, Claude Code escribe el aviso de arriba.
                info.ultimo = "error"
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
        if info.costo == nil { info.costo = ultimoCosto(ruta, size: size, previo: previo.map { ($0.size, $0.costo) }) }
        info.compactaciones = contarCompactaciones(ruta, size: size, previo: previo.map { ($0.size, $0.compactaciones) })
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
        let info = analizar(ruta, size: size, previo: cache[ruta].map { ($0.size, $0.info.costo, $0.info.compactaciones) })
        cache[ruta] = (size, mtime, info)
        return info
    }

    // Para pruebas/limite.sh: lo que la app deduce de una transcripción suelta.
    func diagnostico(_ ruta: String) -> [String: Any]? {
        guard let info = infoTranscripcion(ruta) else { return nil }
        return ["limitado": info.limitado, "ultimo": info.ultimo ?? NSNull()]
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
        // `shell`: libre, pero con un comando que dejó corriendo en segundo plano (se resuelve en leer())
        if status == "idle" || status == "shell" {
            let desde = ahora - ((p["statusUpdatedAt"] as? Double) ?? (p["updatedAt"] as? Double) ?? ahora)
            return desde <= terminoMaxMs ? ("done", "te respondió") : ("idle", "esperando")
        }
        return ("unknown", status ?? "")
    }

    /// Los agentes de Claude Code que están corriendo ahora, más las pestañas de Claude abiertas en VS Code
    /// aunque su agente no esté corriendo. Primero las pineadas; dentro de cada grupo, las que te necesitan.
    func leer() -> [Sesion] {
        let ahora = Date().timeIntervalSince1970 * 1000
        guard let archivos = try? fm.contentsOfDirectory(atPath: sessions.path) else { return [] }
        var out: [Sesion] = []
        var vistos = Set<String>()
        var comandosFondo: [Int: Int]? = nil // se consulta una vez por lectura, solo si hace falta
        for f in archivos where f.range(of: "^\\d+\\.json$", options: .regularExpression) != nil {
            guard let data = fm.contents(atPath: sessions.appendingPathComponent(f).path),
                  let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let sid = p["sessionId"] as? String, let pid = p["pid"] as? Int, vivo(pid) else { continue }
            if let kind = p["kind"] as? String, kind != "interactive" { continue }
            if vistos.contains(sid) { continue }
            vistos.insert(sid)
            let transcripcion = buscarTranscripcion(sid)
            let info = transcripcion.flatMap { infoTranscripcion($0) }
            var (est, detalle) = estado(p, info, ahora: ahora)
            let sub = transcripcion.map { subagentesActivos($0, ahora: ahora) } ?? 0
            var esperandoSubagentes = false
            if est == "done" || est == "idle" {
                // Libre para Claude, pero con trabajo en segundo plano: subagentes o comandos que dejó corriendo
                esperandoSubagentes = sub > 0
                if comandosFondo == nil { comandosFondo = comandosDeFondoPorPid() }
                let cmd = comandosFondo?[pid] ?? 0
                var partes: [String] = []
                if sub > 0 { partes.append("\(sub) \(sub == 1 ? "subagente trabajando" : "subagentes trabajando")") }
                if cmd > 0 { partes.append("\(cmd) \(cmd == 1 ? "comando corriendo" : "comandos corriendo")") }
                if partes.isEmpty && (p["status"] as? String) == "shell" { partes.append("comando corriendo") } // Claude lo informa aunque no veamos la shell
                if !partes.isEmpty { est = "working"; detalle = partes.joined(separator: " y ") + " en segundo plano" }
            }
            let carpeta = (p["cwd"] as? String) ?? info?.carpeta ?? ""
            let enVsCode = (p["entrypoint"] as? String) == "claude-vscode"
            let ref = (p["statusUpdatedAt"] as? Double) ?? (p["updatedAt"] as? Double) ?? (p["startedAt"] as? Double) ?? ahora
            let titulo = [info?.titulo ?? "", p["name"] as? String ?? ""].first { !$0.isEmpty } ?? "Sesión nueva"
            out.append(Sesion(
                id: sid, pid: pid, titulo: titulo, branch: info?.branch ?? "",
                repo: carpeta.isEmpty ? "" : (carpeta as NSString).lastPathComponent, carpeta: carpeta,
                estado: est, detalle: detalle, edadMs: ahora - ref, nacio: (p["startedAt"] as? Double) ?? 0,
                heroe: heroe(sid), enVsCode: true,
                pista: enVsCode ? "Clic para abrirla en VS Code" : "Clic para ir a su pestaña de la Terminal",
                costo: info?.costo.map { ($0 * 100).rounded() / 100 }, contexto: info?.contexto, ventana: ventana(info), compactaciones: info?.compactaciones ?? 0,
                subagentes: sub, esperandoSubagentes: esperandoSubagentes))
        }

        // Las pestañas de Claude abiertas en VS Code, aunque su agente no esté corriendo (como en la extensión)
        for pin in pineadasDeVsCode() {
            var id = pin.id
            if id == nil, !pin.carpeta.isEmpty {
                let clave = "\(pin.carpeta)|\(pin.titulo)"
                // Lo no encontrado se reintenta al minuto (la conversación puede recibir su título más tarde).
                if let previo = idPorTitulo[clave], previo.id != nil || ahora - previo.ts <= 60 * 1000 {
                    id = previo.id
                } else {
                    let vivoConTitulo = out.first { $0.carpeta == pin.carpeta && mismoTitulo($0.titulo, pin.titulo) }
                    id = vivoConTitulo?.id ?? buscarPorTitulo(pin.carpeta, pin.titulo)
                    idPorTitulo[clave] = (id, ahora)
                }
            }
            guard let id else { continue }
            if let i = out.firstIndex(where: { $0.id == id }) { out[i].pineada = out[i].pineada || pin.pineada; continue }
            let transcripcion = buscarTranscripcion(id)
            let info = transcripcion.flatMap { infoTranscripcion($0) }
            let carpeta = pin.carpeta.isEmpty ? info?.carpeta ?? "" : pin.carpeta
            var t = Sesion(
                id: id, pid: 0, titulo: [info?.titulo ?? "", pin.titulo].first { !$0.isEmpty } ?? "Sesión nueva",
                branch: info?.branch ?? "", repo: carpeta.isEmpty ? "" : (carpeta as NSString).lastPathComponent,
                carpeta: carpeta, estado: "idle", detalle: "agente sin abrir: tocala para retomarla", edadMs: 0, nacio: 0,
                heroe: heroe(id), enVsCode: true, pista: "Clic para abrirla en VS Code",
                costo: info?.costo.map { ($0 * 100).rounded() / 100 }, contexto: info?.contexto, ventana: ventana(info), compactaciones: info?.compactaciones ?? 0,
                subagentes: 0, esperandoSubagentes: false)
            t.pineada = pin.pineada
            vistos.insert(id)
            out.append(t)
        }

        let usados = Set(vistos.compactMap { rutas[$0] })
        for k in cache.keys where !usados.contains(k) { cache.removeValue(forKey: k) }
        var ordenadas = out.sorted {
            if $0.pineada != $1.pineada { return $0.pineada }
            let (a, b) = (prioridad[$0.estado] ?? 9, prioridad[$1.estado] ?? 9)
            if a != b { return a < b }
            if $0.nacio != $1.nacio { return $0.nacio > $1.nacio }
            return $0.titulo.compare($1.titulo, locale: Locale(identifier: "es")) == .orderedAscending
        }
        asignarNivelesDeGasto(&ordenadas)
        return ordenadas
    }

    // Cada ventana de VS Code con la extensión publica sus pestañas de Claude (con cuáles están pineadas) en
    // <globalStorage>/pineadas/<pid>.json (las de ventanas cerradas se ignoran; las borra la extensión).
    private func pineadasDeVsCode() -> [(id: String?, titulo: String, carpeta: String, pineada: Bool)] {
        let global = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Code/User/globalStorage")
        var out: [(id: String?, titulo: String, carpeta: String, pineada: Bool)] = []
        let dirs = ((try? fm.contentsOfDirectory(atPath: global.path)) ?? []).filter { $0.lowercased().hasSuffix(".dungeon-de-agentes") }
        for d in dirs {
            let dir = global.appendingPathComponent(d).appendingPathComponent("pineadas")
            for f in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where f.range(of: "^\\d+\\.json$", options: .regularExpression) != nil {
                guard let data = fm.contents(atPath: dir.appendingPathComponent(f).path),
                      let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let pid = p["pid"] as? Int, vivo(pid) else { continue }
                let carpeta = p["carpeta"] as? String ?? ""
                for s in p["sesiones"] as? [[String: Any]] ?? [] {
                    // Las versiones anteriores de la extensión publicaban solo las pineadas, sin este dato
                    out.append((s["id"] as? String, s["titulo"] as? String ?? "", carpeta, s["pineada"] as? Bool ?? true))
                }
            }
        }
        return out
    }

    private func mismoTitulo(_ a: String, _ b: String) -> Bool {
        func norm(_ s: String) -> String {
            s.replacingOccurrences(of: "(…|\\.\\.\\.)\\s*$", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces).lowercased()
        }
        let (x, y) = (norm(a), norm(b))
        if x.isEmpty || y.isEmpty { return false }
        return x == y || (min(x.count, y.count) >= 6 && (x.hasPrefix(y) || y.hasPrefix(x)))
    }

    // Una pestaña pineada de la que no se sabe la sesión: se busca por título entre las transcripciones
    // recientes de su carpeta (~/.claude/projects/<carpeta con lo que no es letra o número cambiado por ->/).
    private func buscarPorTitulo(_ carpeta: String, _ titulo: String) -> String? {
        let dir = projects.appendingPathComponent(carpeta.replacingOccurrences(of: "[^a-zA-Z0-9]", with: "-", options: .regularExpression))
        let files = ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.pathExtension == "jsonl" }
            .map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
            .sorted { $0.1 > $1.1 }.prefix(40)
        for (url, _) in files {
            if let info = infoTranscripcion(url.path), mismoTitulo(info.titulo, titulo) {
                let id = url.deletingPathExtension().lastPathComponent
                rutas[id] = url.path
                return id
            }
        }
        return nil
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
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        // Leer antes de esperar: con salidas grandes (ps) el comando se traba si nadie vacía el canal.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
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
        // La carpeta de la extensión es «<publicador>.dungeon-de-agentes»: tomo la usada más recientemente
        // (así anda con cualquier publicador, incluso si quedó instalada una versión vieja).
        let global = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Code/User/globalStorage")
        let candidatas = ((try? fm.contentsOfDirectory(at: global, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.lastPathComponent.lowercased().hasSuffix(".dungeon-de-agentes") }
        let dir = candidatas.max {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a < b
        } ?? global.appendingPathComponent("fyeflowrith.dungeon-de-agentes")
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
        let deVsCode = s.pid == 0 || lector.esDeVsCode(pid: s.pid) // pid 0: pineada de VS Code sin agente
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

// --analizar <transcripción.jsonl>: imprime lo que se deduce de ese archivo como JSON y sale.
if let i = CommandLine.arguments.firstIndex(of: "--analizar"), i + 1 < CommandLine.arguments.count {
    guard let d = Lector().diagnostico(CommandLine.arguments[i + 1]),
          let data = try? JSONSerialization.data(withJSONObject: d, options: .sortedKeys) else { exit(1) }
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

let app = NSApplication.shared
let delegado = App()
app.delegate = delegado
app.setActivationPolicy(.regular)
app.run()
