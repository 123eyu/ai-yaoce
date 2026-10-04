import Foundation
import CryptoKit

enum MonitorSource: String, CaseIterable, Identifiable {
    case mirasim, codex, claude, zcodex
    case dshDeepseek = "dsh-deepseek"
    case qwenCodex = "qwen-codex"
    case kimiCodex = "kimi-codex"
    static let allCases: [MonitorSource] = [.codex, .claude, .zcodex, .dshDeepseek, .qwenCodex, .kimiCodex]
    var id: String { rawValue }
    var title: String {
        switch self {
        case .mirasim: return "Mirasim"
        case .codex: return "Codex"
        case .claude: return "Claude Code"
        case .zcodex: return "zCodex"
        case .dshDeepseek: return "DSH DeepSeek"
        case .qwenCodex: return "Qwen Codex"
        case .kimiCodex: return "Kimi Codex"
        }
    }

    static func restored(from defaults: UserDefaults, override: String? = nil) -> MonitorSource {
        MonitorSource(rawValue: override ?? "")
            ?? MonitorSource(rawValue: defaults.string(forKey: "monitorSource") ?? "") ?? .codex
    }

    func save(to defaults: UserDefaults) {
        defaults.set(rawValue, forKey: "monitorSource")
    }
}

struct UsageTokens: Equatable {
    var input: Double = 0
    var cached: Double = 0
    var written: Double = 0
    var output: Double = 0
    var total: Double { input + cached + written + output }

    static func number(_ value: Any?) -> Double {
        guard let number = value as? NSNumber else { return 0 }
        let result = number.doubleValue
        return result.isFinite ? max(0, min(result, 1e15)) : 0
    }

    static func codex(_ data: [String: Any]) -> UsageTokens {
        let allInput = number(data["input_tokens"])
        let cached = min(allInput, number(data["cached_input_tokens"]))
        let written = min(allInput - cached, number(data["cache_write_input_tokens"]))
        return UsageTokens(input: allInput - cached - written, cached: cached,
                           written: written, output: number(data["output_tokens"]))
    }

    static func claude(_ data: [String: Any]) -> UsageTokens {
        UsageTokens(input: number(data["input_tokens"]), cached: number(data["cache_read_input_tokens"]),
                    written: number(data["cache_creation_input_tokens"]), output: number(data["output_tokens"]))
    }

    func subtracting(_ other: UsageTokens) -> UsageTokens {
        UsageTokens(input: max(0, input - other.input), cached: max(0, cached - other.cached),
                    written: max(0, written - other.written), output: max(0, output - other.output))
    }

    func merged(_ other: UsageTokens) -> UsageTokens {
        UsageTokens(input: max(input, other.input), cached: max(cached, other.cached),
                    written: max(written, other.written), output: max(output, other.output))
    }
}

struct UsageRecord: Identifiable {
    let id: String
    let source: MonitorSource
    var at: Date
    var session: String
    var model: String
    var provider: String
    var tokens: UsageTokens
    var requestID: String?
    var durationMS: Double?
    var failed = false
    var viaMirasim = false
    var priceUnsupported = false

    var requestKey: String? {
        guard let requestID, !requestID.isEmpty, model != "未知模型" else { return nil }
        return "\(source.rawValue)/\(model)/\(requestID)"
    }

    func merged(with other: UsageRecord) -> UsageRecord {
        var merged = self
        merged.tokens = tokens.merged(other.tokens)
        merged.at = min(at, other.at)
        merged.failed = failed || other.failed
        merged.viaMirasim = viaMirasim || other.viaMirasim
        merged.priceUnsupported = priceUnsupported || other.priceUnsupported
        if merged.requestID?.isEmpty != false { merged.requestID = other.requestID }
        if merged.durationMS == nil { merged.durationMS = other.durationMS }
        if merged.model == "未知模型" { merged.model = other.model }
        if merged.provider.isEmpty { merged.provider = other.provider }
        return merged
    }
}

struct ClientTurn {
    var at: Date
    var durationMS: Double
}

final class UsageLogParser {
    let source: MonitorSource
    let relay: Bool
    private(set) var records: [String: UsageRecord] = [:]
    private(set) var turns: [String: ClientTurn] = [:]
    private(set) var malformed = 0
    private(set) var discontinuities = 0
    private var session: String
    private var model = "未知模型"
    private var provider = ""
    private var total = UsageTokens()
    private var hasTotal = false
    private var sequence = 0
    private let managed: Bool
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    init(source: MonitorSource, fileID: String, managed: Bool = false, relay: Bool = false) {
        self.source = source
        self.session = fileID
        self.managed = managed
        self.relay = relay
    }

    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        return fractional.date(from: text) ?? plain.date(from: text)
    }

    func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        guard let row = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            malformed += 1
            return
        }
        sequence += 1
        if relay { consumeRelay(row); return }
        if source == .claude { consumeClaude(row); return }
        let payload = row["payload"] as? [String: Any] ?? [:]
        switch row["type"] as? String {
        case "session_meta":
            session = payload["id"] as? String ?? payload["session_id"] as? String ?? session
            provider = payload["model_provider"] as? String ?? provider
        case "turn_context":
            model = payload["model"] as? String ?? model
        case "event_msg":
            guard let at = Self.date(row["timestamp"]) else { return }
            let kind = payload["type"] as? String ?? ""
            if kind == "token_count", let info = payload["info"] as? [String: Any],
               let counters = info["total_token_usage"] as? [String: Any] {
                let current = UsageTokens.codex(counters)
                let last = (info["last_token_usage"] as? [String: Any]).map(UsageTokens.codex)
                var delta = current.subtracting(total)
                if hasTotal && current.total < total.total {
                    discontinuities += 1
                    return
                }
                if hasTotal && abs(delta.total - (current.total - total.total)) > 0.001 {
                    discontinuities += 1
                    total = current
                    return
                }
                if !hasTotal, let last, current.total > last.total {
                    delta = last
                    discontinuities += 1
                }
                total = current
                hasTotal = true
                guard delta.total > 0 else { return }
                let key = "codex/\(session)/\(current.input)/\(current.cached)/\(current.written)/\(current.output)"
                records[key] = UsageRecord(id: key, source: .codex, at: at, session: session,
                                          model: model, provider: provider, tokens: delta,
                                          viaMirasim: managed || provider.lowercased() == "mirasim")
            } else if ["task_complete", "turn_complete"].contains(kind),
                      let turn = payload["turn_id"] as? String {
                let duration = UsageTokens.number(payload["duration_ms"])
                if duration > 0 { turns["\(session)/\(turn)"] = ClientTurn(at: at, durationMS: duration) }
            } else if kind == "error" {
                let key = "codex/\(session)/error/\(at.timeIntervalSince1970)/\(sequence)"
                records[key] = UsageRecord(id: key, source: .codex, at: at, session: session,
                                          model: model, provider: provider, tokens: UsageTokens(),
                                          failed: true, viaMirasim: managed || provider == "mirasim")
            }
        default: break
        }
    }

    private func consumeClaude(_ row: [String: Any]) {
        guard row["type"] as? String == "assistant", let at = Self.date(row["timestamp"]),
              let message = row["message"] as? [String: Any] else { return }
        let session = row["sessionId"] as? String ?? self.session
        let failed = row["isApiErrorMessage"] as? Bool == true
        let model = message["model"] as? String ?? "未知模型"
        guard model != "<synthetic>" || failed else { return }
        let request = row["requestId"] as? String
        guard let identity = message["id"] as? String ?? request ?? row["uuid"] as? String else { return }
        let key = "claude/\(session)/\(identity)"
        let usage = message["usage"] as? [String: Any] ?? [:]
        let tokens = UsageTokens.claude(usage)
        guard tokens.total > 0 || failed else { return }
        let hourly = (usage["cache_creation"] as? [String: Any])?["ephemeral_1h_input_tokens"]
        var record = UsageRecord(id: key, source: .claude, at: at, session: session,
                                 model: model, provider: "anthropic", tokens: tokens, requestID: request,
                                 failed: failed, viaMirasim: managed,
                                 priceUnsupported: UsageTokens.number(hourly) > 0)
        if let previous = records[key] {
            record = record.merged(with: previous)
        }
        records[key] = record
    }

    private func consumeRelay(_ row: [String: Any]) {
        guard row["leg"] as? String == "relay", let at = Self.date(row["ts"]),
              let identity = row["id"] as? String,
              let source = MonitorSource(rawValue: row["agent"] as? String ?? ""),
              source != .mirasim else { return }
        let key = "relay/\(identity)"
        let status = UsageTokens.number(row["status"])
        records[key] = UsageRecord(id: key, source: source, at: at,
                                  session: row["sessionId"] as? String ?? "未知会话",
                                  model: row["model"] as? String ?? "未知模型",
                                  provider: row["provider"] as? String ?? "",
                                  tokens: UsageTokens(input: UsageTokens.number(row["input"]),
                                                      cached: UsageTokens.number(row["cacheRead"]),
                                                      written: UsageTokens.number(row["cacheWrite"]),
                                                      output: UsageTokens.number(row["output"])),
                                  requestID: row["providerCallId"] as? String,
                                  durationMS: UsageTokens.number(row["durationMs"]),
                                  failed: status >= 400, viaMirasim: true)
    }

    func prune(before date: Date) {
        records = records.filter { $0.value.at >= date }
        turns = turns.filter { $0.value.at >= date }
    }
}

struct LocalPriceCatalog {
    var rates: [String: [String: Double]] = [:]
    var overrides = PricingRules()

    init(data: Data? = nil) {
        guard let data, let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let providers = root["data"] as? [String: Any] else { return }
        for (provider, value) in providers {
            guard let models = (value as? [String: Any])?["models"] as? [String: Any] else { continue }
            for (model, value) in models {
                guard let cost = (value as? [String: Any])?["cost"] as? [String: Any] else { continue }
                var rate: [String: Double] = [:]
                for key in ["input", "output", "cache_read", "cache_write"] {
                    if let number = cost[key] as? NSNumber, number.doubleValue.isFinite, number.doubleValue >= 0 {
                        rate[key] = number.doubleValue
                    }
                }
                rates["\(provider.lowercased())/\(model)"] = rate
            }
        }
    }

    func estimate(_ record: UsageRecord) -> Double? {
        guard !record.priceUnsupported, record.tokens.total > 0 else { return nil }
        let rate = overrides.resolve(source: record.source.rawValue, provider: record.provider, model: record.model) {
            defaultRate(provider: record.provider, model: $0)
        }
        return PricingRules.estimate(prices: rate, input: record.tokens.input, output: record.tokens.output,
                                     read: record.tokens.cached, write: record.tokens.written)
    }

    func defaultRate(provider rawProvider: String, model: String) -> [String: Double] {
        lookupRate(provider: rawProvider, model: model) ?? [:]
    }

    func lookupRate(provider rawProvider: String, model: String) -> [String: Double]? {
        var provider = rawProvider.lowercased()
        for suffix in ["-responses", "-chat", "-completions", "-messages"] where provider.hasSuffix(suffix) {
            provider.removeLast(suffix.count)
            break
        }
        var rate = rates["\(provider)/\(model)"]
        if rate == nil {
            let manufacturer: String?
            if model.hasPrefix("claude-") { manufacturer = "anthropic" }
            else if model.hasPrefix("gpt-") || model.hasPrefix("o3") || model.hasPrefix("o4") { manufacturer = "openai" }
            else if model.hasPrefix("gemini-") { manufacturer = "google" }
            else if model.hasPrefix("deepseek-") { manufacturer = "deepseek" }
            else { manufacturer = nil }
            if let manufacturer { rate = rates["\(manufacturer)/\(model)"] }
        }
        return rate
    }
}

struct ModelUsage: Identifiable {
    let id: String
    var tokens: Double = 0
    var count = 0
}

struct ClientSummary {
    let source: MonitorSource
    var todayTokens: Double = 0
    var weekTokens: Double = 0
    var monthTokens: Double = 0
    var todayRecords = 0
    var weekRecords = 0
    var errors = 0
    var estimatedUSD: Double = 0
    var monthEstimatedUSD: Double = 0
    var monthPricedRecords = 0
    var monthUnpricedRecords = 0
    var pricedRecords = 0
    var manualRecords = 0
    var providers: [String] = []
    var unpricedRecords = 0
    var sessions = 0
    var managedRecords = 0
    var models: [ModelUsage] = []
    var recent: [UsageRecord] = []
    var relayRecords = 0
    var relayTokens: Double = 0
    var matchedRecords = 0
    var relayModels: [String] = []
    var medianTurnSeconds: Double?
    var latest: Date?
    var scannedAt: Date?
    var fileCount = 0
    var warnings: [String] = []
}

enum ClientAggregation {
    static func summarize(source: MonitorSource, records: [UsageRecord], relay: [UsageRecord],
                          turns: [ClientTurn] = [], prices: LocalPriceCatalog, now: Date = Date()) -> ClientSummary {
        let since = now.addingTimeInterval(-7 * 86400)
        let midnight = Calendar.current.startOfDay(for: now)
        let monthStart = Calendar.current.dateInterval(of: .month, for: now)?.start ?? midnight
        var unique: [String: UsageRecord] = [:]
        for record in records where record.source == source && record.at >= min(since, monthStart) && record.at <= now {
            if let old = unique[record.id] {
                unique[record.id] = record.merged(with: old)
            } else { unique[record.id] = record }
        }
        var relayUnique: [String: UsageRecord] = [:]
        for record in relay where record.source == source && record.at >= since && record.at <= now {
            relayUnique[record.id] = record
        }
        let requestIDs = Set(unique.values.compactMap(\.requestKey))
        let matched = relayUnique.values.filter { $0.requestKey.map(requestIDs.contains) ?? false }
        let unmatched = relayUnique.values.filter { !($0.requestKey.map(requestIDs.contains) ?? false) }
        let matchedIDs = Set(matched.compactMap(\.requestKey))
        var result = ClientSummary(source: source)
        var models: [String: ModelUsage] = [:]
        var sessions = Set<String>()
        for record in unique.values {
            result.latest = max(result.latest ?? record.at, record.at)
            if record.at >= monthStart && record.tokens.total > 0 {
                result.monthTokens += record.tokens.total
                if let estimate = prices.estimate(record) {
                    result.monthEstimatedUSD += estimate
                    result.monthPricedRecords += 1
                } else { result.monthUnpricedRecords += 1 }
            }
            guard record.at >= since else { continue }
            if record.failed { result.errors += 1 }
            guard record.tokens.total > 0 else { continue }
            result.weekTokens += record.tokens.total
            result.weekRecords += 1
            sessions.insert(record.session)
            if record.viaMirasim || record.requestKey.map(matchedIDs.contains) == true { result.managedRecords += 1 }
            var model = models[record.model] ?? ModelUsage(id: record.model)
            model.tokens += record.tokens.total
            model.count += 1
            models[record.model] = model
            if record.at >= midnight {
                result.todayTokens += record.tokens.total
                result.todayRecords += 1
                if let estimate = prices.estimate(record) {
                    result.estimatedUSD += estimate
                    result.pricedRecords += 1
                    if prices.overrides.match(source: source.rawValue, provider: record.provider, model: record.model) != nil {
                        result.manualRecords += 1
                    }
                } else { result.unpricedRecords += 1 }
            }
        }
        result.sessions = sessions.count
        result.providers = Set(unique.values.map(\.provider).filter { !$0.isEmpty }).sorted()
        result.models = models.values.sorted { $0.tokens == $1.tokens ? $0.id < $1.id : $0.tokens > $1.tokens }
        result.recent = unique.values.sorted { $0.at > $1.at }.prefix(8).map { $0 }
        result.matchedRecords = matched.count
        result.relayRecords = unmatched.count
        result.relayTokens = unmatched.reduce(0) { $0 + $1.tokens.total }
        result.relayModels = Set(unmatched.map(\.model)).sorted()
        let durations = turns.filter { $0.at >= since && $0.at <= now && $0.durationMS > 0 }.map(\.durationMS).sorted()
        if !durations.isEmpty {
            let middle = durations.count / 2
            result.medianTurnSeconds = (durations.count.isMultiple(of: 2)
                ? (durations[middle - 1] + durations[middle]) / 2 : durations[middle]) / 1000
        }
        return result
    }
}

final class ClientTelemetryReader {
    struct Root {
        let url: URL
        let source: MonitorSource
        let managed: Bool
        var relay = false
    }

    private final class FileState {
        let parser: UsageLogParser
        var offset: UInt64 = 0
        var size: UInt64 = 0
        var modified = Date.distantPast
        var pending = Data()
        var droppingLine = false
        var prefixHash = SHA256()
        init(root: Root, url: URL) {
            parser = UsageLogParser(source: root.source, fileID: url.lastPathComponent,
                                    managed: root.managed, relay: root.relay)
        }
    }

    private var files: [String: FileState] = [:]
    private let roots: [Root]
    private let catalogURL: URL
    private var prices = LocalPriceCatalog()
    private var catalogModified: Date?

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
         environment: [String: String] = ProcessInfo.processInfo.environment) {
        var roots: [Root] = []
        let codexHomes = [home.appendingPathComponent(".codex")] + (environment["CODEX_HOME"].map { [URL(fileURLWithPath: $0)] } ?? [])
        for base in codexHomes {
            for folder in ["sessions", "archived_sessions"] {
                roots.append(Root(url: base.appendingPathComponent(folder), source: .codex, managed: base.path.contains("/.mirasim/")))
            }
        }
        let claudeHomes = [home.appendingPathComponent(".claude")] + (environment["CLAUDE_CONFIG_DIR"].map { [URL(fileURLWithPath: $0)] } ?? [])
        for base in claudeHomes { roots.append(Root(url: base.appendingPathComponent("projects"), source: .claude, managed: false)) }
        let managed = home.appendingPathComponent(".mirasim/agent-homes")
        for base in (try? FileManager.default.contentsOfDirectory(at: managed, includingPropertiesForKeys: nil)) ?? [] {
            if base.lastPathComponent.lowercased().contains("codex") {
                for folder in ["sessions", "archived_sessions"] { roots.append(Root(url: base.appendingPathComponent(folder), source: .codex, managed: true)) }
            } else if base.lastPathComponent.lowercased().contains("claude") {
                roots.append(Root(url: base.appendingPathComponent("projects"), source: .claude, managed: true))
            }
        }
        var seen = Set<String>()
        self.roots = roots.filter { seen.insert($0.url.resolvingSymlinksInPath().path).inserted }
        catalogURL = home.appendingPathComponent(".ai-yaoce/models-dev-cache.json")
    }

    private func prefixMatches(_ url: URL, state: FileState) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var remaining = state.offset
        var hash = SHA256()
        while remaining > 0 {
            guard let data = try handle.read(upToCount: Int(min(remaining, 262144))), !data.isEmpty else { return false }
            hash.update(data: data)
            remaining -= UInt64(data.count)
        }
        return hash.finalize() == state.prefixHash.finalize()
    }

    func refresh(now: Date = Date()) -> [MonitorSource: ClientSummary] {
        let manager = FileManager.default
        let horizon = now.addingTimeInterval(-35 * 86400)
        let catalogDate = (try? catalogURL.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        if catalogDate != catalogModified {
            let previousOverrides = prices.overrides
            prices = LocalPriceCatalog(data: try? Data(contentsOf: catalogURL))
            prices.overrides = previousOverrides
            catalogModified = catalogDate
        }
        var candidates: [(URL, Root, Date)] = []
        var issues: [MonitorSource: Set<String>] = [:]
        do { prices.overrides = try PricingRules.load() }
        catch {
            for source in [MonitorSource.codex, .claude] { issues[source, default: []].insert("价格配置读取失败，保留上次生效规则") }
        }
        for root in roots {
            guard manager.fileExists(atPath: root.url.path) else { continue }
            guard let iterator = manager.enumerator(at: root.url, includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey],
                                                     options: [.skipsHiddenFiles], errorHandler: { _, _ in
                issues[root.source, default: []].insert("部分日志不可读")
                return true
            }) else { issues[root.source, default: []].insert("日志目录不可读"); continue }
            var visited = 0
            for case let url as URL in iterator {
                visited += 1
                if visited > 12000 { issues[root.source, default: []].insert("目录扫描达到上限，统计不完整"); break }
                guard url.pathExtension == (root.relay ? "ndjson" : "jsonl"),
                      !root.relay || url.lastPathComponent.hasPrefix("usage-"),
                      let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey]),
                      values.isRegularFile == true, let modified = values.contentModificationDate, modified >= horizon else { continue }
                candidates.append((url, root, modified))
            }
        }
        candidates.sort { $0.2 > $1.2 }
        var seen = Set<String>()
        candidates = candidates.filter { seen.insert($0.0.resolvingSymlinksInPath().path).inserted }
        if candidates.count > 400 {
            for source in MonitorSource.allCases { issues[source, default: []].insert("仅扫描最近 400 个日志文件") }
            candidates = Array(candidates.prefix(400))
        }
        var active = Set<String>()
        var fileCounts: [MonitorSource: Int] = [:]
        var remainingBytes = 64 * 1024 * 1024
        for (url, root, modified) in candidates {
            let path = url.resolvingSymlinksInPath().path
            active.insert(path)
            guard let attrs = try? manager.attributesOfItem(atPath: path), let size = (attrs[.size] as? NSNumber)?.uint64Value else { continue }
            if files[path] == nil || size < (files[path]?.offset ?? 0) { files[path] = FileState(root: root, url: url) }
            guard var state = files[path] else { continue }
            if state.offset > 0 && (state.modified != modified || state.size != size) {
                do {
                    if try !prefixMatches(url, state: state) {
                        state = FileState(root: root, url: url)
                        files[path] = state
                    }
                } catch {
                    issues[root.source, default: []].insert("日志完整性校验失败，保留上次结果")
                    continue
                }
            }
            fileCounts[root.source, default: 0] += 1
            if state.offset < size {
                do {
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    try handle.seek(toOffset: state.offset)
                    var budget = min(remainingBytes, 8 * 1024 * 1024)
                    while budget > 0, let data = try handle.read(upToCount: min(budget, 262144)), !data.isEmpty {
                        budget -= data.count
                        remainingBytes -= data.count
                        state.offset += UInt64(data.count)
                        state.prefixHash.update(data: data)
                        state.pending.append(data)
                        while let newline = state.pending.firstIndex(of: 10) {
                            let line = state.pending.prefix(upTo: newline)
                            if !state.droppingLine { state.parser.consume(Data(line)) }
                            state.droppingLine = false
                            state.pending.removeSubrange(...newline)
                        }
                        if state.pending.count > 4 * 1024 * 1024 {
                            state.pending.removeAll(keepingCapacity: false)
                            state.droppingLine = true
                            issues[root.source, default: []].insert("已跳过超大日志行")
                        }
                    }
                } catch { issues[root.source, default: []].insert("部分日志读取失败") }
            }
            state.size = size
            state.modified = modified
            state.parser.prune(before: horizon)
            if state.offset < size { issues[root.source, default: []].insert("日志仍在分批读取，当前为部分统计") }
            if state.parser.malformed > 0 { issues[root.source, default: []].insert("已跳过损坏日志行") }
            if state.parser.discontinuities > 0 { issues[root.source, default: []].insert("部分累计基线不完整，未回算历史 token") }
        }
        files = files.filter { active.contains($0.key) }
        var records: [UsageRecord] = []
        var relay: [UsageRecord] = []
        var turns: [MonitorSource: [String: ClientTurn]] = [:]
        for file in files.values {
            if file.parser.relay { relay.append(contentsOf: file.parser.records.values) }
            else {
                records.append(contentsOf: file.parser.records.values)
                turns[file.parser.source, default: [:]].merge(file.parser.turns) { old, _ in old }
            }
        }
        var results: [MonitorSource: ClientSummary] = [:]
        for source in MonitorSource.allCases {
            var result = ClientAggregation.summarize(source: source, records: records, relay: relay,
                                                     turns: Array((turns[source] ?? [:]).values), prices: prices, now: now)
            result.fileCount = fileCounts[source] ?? 0
            result.scannedAt = now
            result.warnings = Array((issues[source] ?? []).union(issues[.mirasim] ?? [])).sorted()
            results[source] = result
        }
        return results
    }
}
