import SwiftUI

final class PricingEditor: ObservableObject {
    @Published var config = PricingRules()
    @Published var source = "codex"
    @Published var provider = ""
    @Published var model = ""
    @Published var alias = ""
    @Published var input = ""
    @Published var output = ""
    @Published var read = ""
    @Published var write = ""
    @Published var message = ""
    @Published var expanded = false
    @Published var loadFailed = false
    private var editingID: String?
    private let configURL: URL

    init(url: URL = PricingRules.url, preview: Bool = CommandLine.arguments.contains("--fixture")) {
        configURL = url
        if preview {
            expanded = CommandLine.arguments.contains("--pricing")
            return
        }
        do { config = try PricingRules.load(from: configURL) }
        catch { message = "无法读取价格配置，请先检查本地文件；未覆盖原文件。"; loadFailed = true }
    }

    func edit(_ rule: PricingRule) {
        editingID = rule.id
        source = rule.source; provider = rule.provider; model = rule.model; alias = rule.alias
        input = rule.prices["input"].map { String($0) } ?? ""
        output = rule.prices["output"].map { String($0) } ?? ""
        read = rule.prices["cache_read"].map { String($0) } ?? ""
        write = rule.prices["cache_write"].map { String($0) } ?? ""
        expanded = true; message = ""
    }

    func clear() {
        editingID = nil
        provider = ""; model = ""; alias = ""; input = ""; output = ""; read = ""; write = ""
    }

    func save() -> Bool {
        guard !loadFailed else { return false }
        var prices: [String: Double] = [:]
        for (key, text) in zip(PricingRules.keys, [input, output, read, write]) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let value = Double(trimmed), value.isFinite, value >= 0, value <= 1_000_000 else {
                message = "单价请输入 0～1000000 的数字；留空继承默认。"; return false
            }
            prices[key] = value
        }
        let rule = PricingRule(source: source, provider: provider.trimmingCharacters(in: .whitespacesAndNewlines),
                               model: model.trimmingCharacters(in: .whitespacesAndNewlines),
                               alias: alias.trimmingCharacters(in: .whitespacesAndNewlines), prices: prices)
        var updated = config
        updated.rules.removeAll { $0.id == rule.id || $0.id == editingID }
        updated.rules.append(rule)
        return persist(updated)
    }

    func remove(_ rule: PricingRule) -> Bool {
        guard !loadFailed else { return false }
        var updated = config
        updated.rules.removeAll { $0.id == rule.id }
        return persist(updated)
    }

    private func persist(_ updated: PricingRules) -> Bool {
        do {
            try updated.save(to: configURL)
            config = updated; clear()
            message = "已保存，正在按新规则重估历史用量。"
            return true
        } catch { message = "保存失败：\(error.localizedDescription)"; return false }
    }
}

struct PricingSettingsView: View {
    let onSave: () -> Void
    @StateObject private var editor = PricingEditor()

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("手动价格优先 · 未设置使用默认估算")
                .font(Theme.label(11, .semibold))
            Text("USD / 百万 token。留空继承，0 为免费。保存后重估历史，不等于中转实际账单。")
                .font(Theme.label(10)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(editor.config.rules) { rule in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(rule.source) · \(rule.provider.isEmpty ? "所有渠道" : rule.provider) · \(rule.model)")
                        .font(Theme.mono(10)).lineLimit(2)
                    HStack {
                        SettingsButton(title: "编辑") { editor.edit(rule) }
                        SettingsButton(title: "删除规则", destructive: true) { if editor.remove(rule) { onSave() } }
                    }
                }
            }
            DisclosureGroup("添加 / 编辑价格规则", isExpanded: $editor.expanded) {
                VStack(alignment: .leading, spacing: 6) {
                    Picker("来源", selection: $editor.source) {
                        Text("Mirasim").tag("mirasim")
                        Text("Codex").tag("codex")
                        Text("Claude Code").tag("claude")
                    }.labelsHidden().pickerStyle(.menu)
                    field("日志模型名（必填，精确匹配）", text: $editor.model)
                    field("日志 provider（留空匹配所有）", text: $editor.provider)
                    field("计价模型别名（可选）", text: $editor.alias)
                    Text("provider 只是日志标识，不保证识别中转站。Claude 建议留空。别名不证明后台真实模型。")
                        .font(Theme.label(10)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack { field("输入 $/M", text: $editor.input); field("输出 $/M", text: $editor.output) }
                    HStack { field("缓存读取 $/M", text: $editor.read); field("缓存写入 $/M", text: $editor.write) }
                    HStack {
                        SettingsButton(title: "保存并重算") { if editor.save() { onSave() } }.disabled(editor.loadFailed)
                        SettingsButton(title: "清空表单") { editor.clear() }
                    }
                }.padding(.top, 6)
            }.font(Theme.label(11))
            if !editor.message.isEmpty {
                Text(editor.message).font(Theme.label(10)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text).textFieldStyle(.roundedBorder).font(Theme.label(11))
    }
}
