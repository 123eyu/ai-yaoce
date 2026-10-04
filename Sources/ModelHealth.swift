import Foundation
import Combine
import Security

struct HealthTarget: Codable, Identifiable {
    var id = UUID().uuidString
    var source = ""
    var endpoint = ""
    var model = ""
    var protocolName = "chat"
    var apiKey = ""
    var enabled = true
    var reasoning = false
    var inputPrice: Double?
    var outputPrice: Double?
}

struct HealthConfig: Codable {
    var enabled = false
    var interval: Double = 600
    var timeout: Double = 30
    var prompt = "Reply 1"
    var maxTokens = 8
    var targets: [HealthTarget] = []

    func validated() throws -> HealthConfig {
        guard interval.isFinite, (10...86400).contains(interval), timeout.isFinite, (1...300).contains(timeout),
              (1...4096).contains(maxTokens), !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              prompt.count <= 1000 else { throw HealthFailure.invalid }
        var ids = Set<String>(), identities = Set<String>()
        for target in targets {
            guard !target.id.isEmpty, target.id.count <= 100, ids.insert(target.id).inserted,
                  !target.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, target.model.count <= 300,
                  target.source.count <= 100, ["chat", "responses", "anthropic"].contains(target.protocolName),
                  target.apiKey.count <= 8192, !target.apiKey.contains("\r"), !target.apiKey.contains("\n"),
                  let url = URLComponents(string: target.endpoint), let host = url.host, !host.isEmpty,
                  url.url != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
            else { throw HealthFailure.invalid }
            for price in [target.inputPrice, target.outputPrice].compactMap({ $0 }) {
                guard price.isFinite, (0...1000000).contains(price) else { throw HealthFailure.invalid }
            }
            let identity = try JSONEncoder().encode([target.endpoint, target.protocolName, target.model, target.apiKey]).base64EncodedString()
            guard identities.insert(identity).inserted else { throw HealthFailure.invalid }
        }
        return self
    }
}

enum HealthFailure: Error { case invalid, storage }

struct HealthResult {
    var state = "待检测"
    var input: Double?
    var output: Double?
    var checkedAt: Date?
    var latency: Double = 0
    var nextAt = Date.distantPast
    var failures = 0
}

struct HealthStats {
    var requests = 0
    var input: Double = 0
    var output: Double = 0
    var unknownUsage = 0
    var estimatedUSD: Double = 0
    var unpriced = 0
}

enum HealthWire {
    static func request(_ config: HealthConfig, _ target: HealthTarget) throws -> URLRequest {
        guard let url = URL(string: target.endpoint) else { throw HealthFailure.invalid }
        var request = URLRequest(url: url, timeoutInterval: config.timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["model": target.model, "stream": false]
        let messages = [["role": "user", "content": config.prompt]]
        if target.protocolName == "anthropic" {
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            if !target.apiKey.isEmpty { request.setValue(target.apiKey, forHTTPHeaderField: "x-api-key") }
            body["max_tokens"] = config.maxTokens
            body["messages"] = messages
            body["thinking"] = ["type": "disabled"]
        } else {
            if !target.apiKey.isEmpty { request.setValue("Bearer \(target.apiKey)", forHTTPHeaderField: "Authorization") }
            if target.protocolName == "responses" {
                body["input"] = config.prompt
                body["max_output_tokens"] = config.maxTokens
                body["store"] = false
                if target.reasoning { body["reasoning"] = ["effort": "low"] }
            } else {
                body["messages"] = messages
                body[target.reasoning ? "max_completion_tokens" : "max_tokens"] = config.maxTokens
                if target.reasoning { body["reasoning_effort"] = "low" }
            }
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    static func response(status: Int, data: Data) -> HealthResult {
        guard (200...299).contains(status) else {
            let states = [401: "鉴权失败", 403: "鉴权失败", 404: "模型或接口不存在", 408: "超时", 429: "限流"]
            return HealthResult(state: states[status] ?? (status >= 500 ? "服务错误" : (300...399).contains(status) ? "拒绝重定向" : "请求不兼容"))
        }
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let usage = value["usage"] as? [String: Any] ?? [:]
        func amount(_ primary: String, _ alternate: String) -> Double? {
            guard let number = (usage[primary] ?? usage[alternate]) as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                  number.doubleValue >= 0, number.doubleValue <= 9007199254740991 else { return nil }
            return number.doubleValue
        }
        let choices = value["choices"] as? [[String: Any]]
        let message = choices?.first?["message"] as? [String: Any]
        let content = value["content"] as? [[String: Any]] ?? []
        let output = value["output"] as? [[String: Any]] ?? []
        let parts = output.flatMap { $0["content"] as? [[String: Any]] ?? [] }
        let text = message?["content"] as? String ?? value["output_text"] as? String
            ?? (content + parts).filter { ["text", "output_text"].contains($0["type"] as? String ?? "") }.compactMap { $0["text"] as? String }.joined()
        let details = value["incomplete_details"] as? [String: Any]
        let incomplete = choices?.first?["finish_reason"] as? String == "length" || value["stop_reason"] as? String == "max_tokens"
            || value["status"] as? String == "incomplete" || details?["reason"] as? String == "max_output_tokens"
        return HealthResult(state: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value["error"] == nil && !incomplete ? "可用" : "未确认",
                            input: amount("input_tokens", "prompt_tokens"), output: amount("output_tokens", "completion_tokens"))
    }

    static func retryDelay(_ value: String?, now: Date) -> Double {
        guard let value = value else { return 0 }
        if let seconds = Double(value), seconds.isFinite { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return max(0, formatter.date(from: value)?.timeIntervalSince(now) ?? 0)
    }
}

enum HealthVault {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local.eduhuan.ring.model-health", kSecAttrAccount as String: "configuration"]
    }
    static func load() throws -> HealthConfig {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return HealthConfig() }
        guard status == errSecSuccess, let data = result as? Data else { throw HealthFailure.storage }
        return try JSONDecoder().decode(HealthConfig.self, from: data).validated()
    }
    static func save(_ config: HealthConfig) throws {
        let data = try JSONEncoder().encode(config)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw HealthFailure.storage }
    }
}

struct HealthReply {
    var result: HealthResult
    var retry: Double = 0
}

protocol HealthCancellable: AnyObject { func cancel() }

final class HealthTransfer: NSObject, URLSessionDataDelegate, HealthCancellable, @unchecked Sendable {
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var bytes = Data()
    private var oversized = false
    private var completion: ((HealthReply) -> Void)?

    init(request: URLRequest, completion: @escaping (HealthReply) -> Void) {
        self.completion = completion
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }
    func cancel() { task?.cancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if bytes.count + data.count > 1048576 { oversized = true; dataTask.cancel() }
        else { bytes.append(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let response = task.response as? HTTPURLResponse
        let result: HealthResult
        if oversized { result = HealthResult(state: "未确认") }
        else if let error = error as? URLError { result = HealthResult(state: error.code == .timedOut ? "超时" : "网络失败") }
        else { result = HealthWire.response(status: response?.statusCode ?? 0, data: bytes) }
        let retry = response?.statusCode == 429 ? HealthWire.retryDelay(response?.value(forHTTPHeaderField: "Retry-After"), now: Date()) : 0
        completion?(HealthReply(result: result, retry: retry))
        completion = nil
        session.finishTasksAndInvalidate()
        self.session = nil
        self.task = nil
    }
}

final class ModelHealthController: ObservableObject {
    @Published private(set) var config = HealthConfig()
    @Published private(set) var results: [String: HealthResult] = [:]
    @Published private(set) var stats = HealthStats()
    @Published private(set) var message = ""
    private(set) var storageFailed = false
    private var active: [String: HealthCancellable] = [:]
    private var generation = 0
    private var timer: Timer?
    private let persist: (HealthConfig) throws -> Void
    private let sender: (URLRequest, @escaping (HealthReply) -> Void) -> HealthCancellable
    private let clock: () -> Date

    init(live: Bool = false, initial: HealthConfig? = nil, persist: ((HealthConfig) throws -> Void)? = nil,
         sender: @escaping (URLRequest, @escaping (HealthReply) -> Void) -> HealthCancellable = { HealthTransfer(request: $0, completion: $1) },
         clock: @escaping () -> Date = Date.init) {
        self.persist = persist ?? (live ? HealthVault.save : { _ in })
        self.sender = sender
        self.clock = clock
        do { config = try (initial ?? (live ? HealthVault.load() : HealthConfig())).validated() }
        catch { storageFailed = true; message = "检测配置读取失败，未开启检测；原配置未覆盖，请检查系统钥匙串后重启" }
        if live && !storageFailed {
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        }
    }
    deinit { timer?.invalidate(); for task in active.values { task.cancel() } }
    func save(_ value: HealthConfig) -> Bool {
        guard !storageFailed else { return false }
        do {
            let next = try value.validated()
            if !next.enabled { cancel(); config.enabled = false }
            try persist(next)
            var retained: [String: HealthResult] = [:]
            for target in next.targets {
                guard let old = config.targets.first(where: { $0.id == target.id }), var result = results[target.id],
                      old.endpoint == target.endpoint, old.protocolName == target.protocolName,
                      old.model == target.model, old.apiKey == target.apiKey else { continue }
                if active[target.id] != nil { result.state = "已取消"; result.nextAt = clock().addingTimeInterval(next.interval) }
                if (!old.enabled && target.enabled) || (!config.enabled && next.enabled) { result.nextAt = .distantPast }
                retained[target.id] = result
            }
            cancel(); config = next; results = retained; message = "检测设置已保存"
            return true
        } catch { message = "保存失败：请检查参数、重复模型、HTTPS地址及系统钥匙串权限"; return false }
    }
    private func cancel() {
        generation += 1
        for task in active.values { task.cancel() }
    }
    func check(_ id: String? = nil) {
        guard config.enabled else { message = "请先开启并保存检测开关（请求可能收费）"; return }
        for target in config.targets where target.enabled && (id == nil || target.id == id) && active[target.id] == nil {
            if results[target.id] != nil { results[target.id]?.nextAt = .distantPast }
        }
        tick(preferred: id)
    }
    func tick(preferred: String? = nil) {
        guard config.enabled else { return }
        objectWillChange.send()
        let due = config.targets.filter { $0.enabled && active[$0.id] == nil && (results[$0.id]?.nextAt ?? .distantPast) <= clock() }
            .sorted {
                if $0.id == preferred { return true }
                if $1.id == preferred { return false }
                return (results[$0.id]?.checkedAt ?? .distantPast) < (results[$1.id]?.checkedAt ?? .distantPast)
            }
        for target in due {
            if active.count >= 2 { break }
            start(target)
        }
    }
    private func start(_ target: HealthTarget) {
        guard let request = try? HealthWire.request(config, target) else { return }
        let currentGeneration = generation, started = clock(), previous = results[target.id]
        let interval = config.interval
        results[target.id] = HealthResult(state: "检测中", checkedAt: previous?.checkedAt)
        stats.requests += 1
        active[target.id] = sender(request) { [weak self] reply in
            guard let self = self else { return }
            self.active.removeValue(forKey: target.id)
            guard currentGeneration == self.generation else { self.stats.unknownUsage += 1; self.stats.unpriced += 1; return }
            var result = reply.result
            if result.input == nil || result.output == nil { self.stats.unknownUsage += 1 }
            self.stats.input += result.input ?? 0
            self.stats.output += result.output ?? 0
            if let input = result.input, let output = result.output, let inputPrice = target.inputPrice, let outputPrice = target.outputPrice {
                self.stats.estimatedUSD += (input * inputPrice + output * outputPrice) / 1000000
            } else { self.stats.unpriced += 1 }
            result.failures = result.state == "可用" ? 0 : (previous?.failures ?? 0) + 1
            let delay = max(interval, min(3600, interval * pow(2, Double(min(10, result.failures)))), reply.retry)
            result.checkedAt = self.clock()
            result.latency = self.clock().timeIntervalSince(started) * 1000
            result.nextAt = result.state == "鉴权失败" ? .distantFuture : self.clock().addingTimeInterval(delay)
            self.results[target.id] = result
        }
    }
}
