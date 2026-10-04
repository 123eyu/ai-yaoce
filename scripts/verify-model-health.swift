import Foundation

final class FakeHealthTask: HealthCancellable {
    var cancelled = false
    func cancel() { cancelled = true }
}

@main struct VerifyModelHealth {
    static func main() throws {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ description: String) {
            guard condition() else { fatalError(description) }
            count += 1
            print("PASS \(description)")
        }
        var config = HealthConfig()
        check(!config.enabled && config.interval == 600 && config.prompt == "Reply 1" && config.maxTokens == 8, "safe defaults")
        var target = HealthTarget()
        target.id = "one"; target.model = "model-one"; target.endpoint = "https://example.test/v1/chat/completions"
        target.apiKey = "fixture-secret"; target.inputPrice = 1; target.outputPrice = 2
        config.targets = [target]
        for endpoint in ["http://example.test", "https://user:pass@example.test", "https://example.test/?key=secret", "https://example.test/#secret"] {
            var invalid = config; invalid.targets[0].endpoint = endpoint
            check((try? invalid.validated()) == nil, "reject unsafe URL")
        }
        var many = config
        many.targets = (0..<1200).map { index in var entry = target; entry.id = String(index); entry.model = String(index); return entry }
        check((try? many.validated()) != nil, "no model count cap")
        for protocolName in ["chat", "responses", "anthropic"] {
            var entry = target; entry.protocolName = protocolName
            let request = try HealthWire.request(config, entry)
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            check(request.httpMethod == "POST" && body["tools"] == nil, "minimal \(protocolName) request")
            check((body["max_tokens"] ?? body["max_output_tokens"]) as? Int == 8, "budget \(protocolName)")
        }
        let data = Data(#"{"choices":[{"message":{"content":"1"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#.utf8)
        let parsed = HealthWire.response(status: 200, data: data)
        check(parsed.state == "可用" && parsed.input == 3 && parsed.output == 1, "usage and visible success")
        check(HealthWire.response(status: 200, data: Data("null".utf8)).state == "未确认", "empty success unconfirmed")
        for payload in [#"{"choices":[{"message":{"content":"1"},"finish_reason":"length"}]}"#,
                        #"{"output_text":"1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}"#,
                        #"{"content":[{"type":"text","text":"1"}],"stop_reason":"max_tokens"}"#] {
            check(HealthWire.response(status: 200, data: Data(payload.utf8)).state == "未确认", "partial budget result unconfirmed")
        }
        for (code, state) in [(401, "鉴权失败"), (429, "限流"), (302, "拒绝重定向"), (500, "服务错误")] {
            check(HealthWire.response(status: code, data: Data()).state == state, "HTTP \(code)")
        }
        let now = Date(timeIntervalSince1970: 1000)
        var callbacks: [(HealthReply) -> Void] = []
        var tasks: [FakeHealthTask] = []
        var requested: [String] = []
        let controller = ModelHealthController(initial: config, sender: { request, completion in
            callbacks.append(completion)
            let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            requested.append(body["model"] as! String)
            let task = FakeHealthTask(); tasks.append(task); return task
        }, clock: { now })
        controller.tick(); controller.check()
        check(tasks.isEmpty, "disabled does not request")
        config.enabled = true
        config.targets = (1...3).map { index in var entry = target; entry.id = String(index); entry.model = "model-\(index)"; return entry }
        check(controller.save(config), "save enabled config")
        controller.check("3"); controller.tick()
        check(tasks.count == 2 && requested.first == "model-3", "concurrency cap and manual priority")
        callbacks[0](HealthReply(result: parsed))
        check(controller.stats.input == 3 && controller.stats.estimatedUSD == 0.000005, "separate probe accounting")
        check(controller.results["3"]?.nextAt == now.addingTimeInterval(600), "interval starts at completion")
        callbacks[1](HealthReply(result: HealthResult(state: "限流"), retry: 7200))
        check(controller.results["1"]?.nextAt == now.addingTimeInterval(7200), "Retry-After respected")
        controller.tick()
        check(tasks.count == 3, "next target runs")
        config.enabled = false
        check(controller.save(config) && tasks.last!.cancelled, "disable cancels pending")
        callbacks[2](HealthReply(result: parsed))
        check(controller.results["2"]?.state == "已取消" && controller.stats.unknownUsage == 2, "stale generation discarded")
        config.enabled = true
        _ = controller.save(config)
        controller.check("3")
        callbacks[3](HealthReply(result: HealthResult(state: "鉴权失败")))
        config.prompt = "Reply 2"
        _ = controller.save(config)
        check(controller.results["3"]?.nextAt == .distantFuture, "settings save preserves auth pause")
        let failed = ModelHealthController(persist: { _ in throw HealthFailure.storage })
        config.prompt = "changed"
        check(!failed.save(config) && failed.config.prompt == "Reply 1", "storage error preserves config")
        check(HealthWire.retryDelay("7200", now: now) == 7200, "retry seconds")
        let editor = HealthEditor()
        let edited = ModelHealthController()
        editor.endpoint = "https://example.test/v1/chat/completions"
        editor.models = "model-a\nmodel-b"; editor.apiKey = "fixture-secret"
        editor.add()
        check(editor.targets.count == 2 && editor.apiKey.isEmpty, "editor batch add clears key input")
        editor.interval = "900"; editor.save(edited)
        check(edited.config.targets.count == 2 && edited.config.interval == 900 && !edited.config.enabled, "editor saves disabled settings")
        editor.interval = "invalid"; editor.save(edited)
        check(edited.config.interval == 900, "editor invalid input preserves saved config")
        editor.load(edited.config); editor.targets[0].enabled = false; editor.targets.removeLast(); editor.save(edited)
        check(edited.config.targets.count == 1 && !edited.config.targets[0].enabled && edited.stats.requests == 0, "editor per-target disable and delete without requests")
        if let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--network-port=") }),
           let port = Int(argument.replacingOccurrences(of: "--network-port=", with: "")) {
            for (path, state) in [("redirect", "拒绝重定向"), ("large", "未确认"), ("wait", "超时"), ("ok", "可用")] {
                var entry = target
                entry.endpoint = "http://127.0.0.1:\(port)/\(path)"
                var networkConfig = HealthConfig(); networkConfig.timeout = 1
                var answer: HealthReply?
                let transfer = HealthTransfer(request: try HealthWire.request(networkConfig, entry)) { answer = $0 }
                let deadline = Date().addingTimeInterval(5)
                while answer == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
                check(answer?.result.state == state, "loopback \(path)")
                withExtendedLifetime(transfer) {}
            }
        }
        print("\(count) health checks passed (offline; no Keychain or upstream requests)")
    }
}
