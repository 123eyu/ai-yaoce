import Foundation

struct PricingRule: Codable, Equatable, Identifiable {
    var source: String
    var provider: String
    var model: String
    var alias: String
    var prices: [String: Double]
    var id: String { [source, provider, model].map { "\($0.utf8.count):\($0)" }.joined() }
}

struct PricingRules: Codable, Equatable {
    var rules: [PricingRule] = []
    static let keys = ["input", "output", "cache_read", "cache_write"]
    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ai-yaoce/pricing-rules.json")
    }

    static func load(from url: URL = Self.url) throws -> Self {
        guard FileManager.default.fileExists(atPath: url.path) else { return Self() }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        try value.validate()
        return value
    }

    func validate() throws {
        var identities = Set<String>()
        for rule in rules {
            guard ["codex", "claude", "zcodex", "dsh-deepseek", "qwen-codex", "kimi-codex"].contains(rule.source),
                  !rule.model.isEmpty, identities.insert(rule.id).inserted,
                  rule.prices.keys.allSatisfy(Self.keys.contains),
                  rule.prices.values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1_000_000 }) else {
                throw NSError(domain: "Pricing", code: 1, userInfo: [NSLocalizedDescriptionKey: "规则无效：模型不能为空，单价须为 0～1000000 的有限数字。"])
            }
        }
    }

    func save(to url: URL = Self.url) throws {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    func match(source: String, provider: String, model: String) -> PricingRule? {
        let candidates = rules.filter { $0.source == source && $0.model == model }
        return candidates.first { !$0.provider.isEmpty && $0.provider == provider }
            ?? candidates.first { $0.provider.isEmpty }
    }

    func resolve(source: String, provider: String, model: String,
                 fallback: (String) -> [String: Double]) -> [String: Double] {
        let rule = match(source: source, provider: provider, model: model)
        var result = fallback(rule?.alias.isEmpty == false ? rule!.alias : model)
        for (key, price) in rule?.prices ?? [:] { result[key] = price }
        return result
    }

    static func estimate(prices: [String: Double], input: Double, output: Double,
                         read: Double, write: Double) -> Double? {
        var result = 0.0
        for (key, count) in [("input", input), ("output", output), ("cache_read", read), ("cache_write", write)] where count > 0 {
            guard let price = prices[key], price.isFinite, price >= 0 else { return nil }
            result += count * price / 1_000_000
        }
        return result.isFinite ? result : nil
    }
}
