import SwiftUI

final class HealthEditor: ObservableObject {
    @Published var expanded = CommandLine.arguments.contains("--health")
    @Published var enabled = false
    @Published var interval = "600"
    @Published var timeout = "30"
    @Published var prompt = "Reply 1"
    @Published var maxTokens = "8"
    @Published var targets: [HealthTarget] = []
    @Published var source = ""
    @Published var endpoint = ""
    @Published var protocolName = "chat"
    @Published var apiKey = ""
    @Published var models = ""
    @Published var reasoning = false
    @Published var inputPrice = ""
    @Published var outputPrice = ""
    @Published var message = ""
    var loaded = false

    func load(_ config: HealthConfig) {
        enabled = config.enabled
        interval = String(format: "%g", config.interval)
        timeout = String(format: "%g", config.timeout)
        prompt = config.prompt
        maxTokens = String(config.maxTokens)
        targets = config.targets
        loaded = true
    }
    func add() {
        let names = models.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !names.isEmpty, inputPrice.isEmpty || Double(inputPrice) != nil,
              outputPrice.isEmpty || Double(outputPrice) != nil else { message = "请输入模型ID和有效单价"; return }
        let additions = names.map { name -> HealthTarget in
            var target = HealthTarget()
            target.source = source.trimmingCharacters(in: .whitespaces)
            target.endpoint = endpoint.trimmingCharacters(in: .whitespaces)
            target.model = name; target.protocolName = protocolName; target.apiKey = apiKey
            target.reasoning = reasoning; target.inputPrice = Double(inputPrice); target.outputPrice = Double(outputPrice)
            return target
        }
        var validation = HealthConfig()
        validation.targets = targets + additions
        do {
            _ = try validation.validated()
            targets = validation.targets; apiKey = ""; models = ""; message = "已加入列表，请保存生效"
        } catch { message = "添加失败：检查重复模型、单价、完整HTTPS地址和密钥格式" }
    }
    func save(_ controller: ModelHealthController) {
        guard let interval = Double(interval), let timeout = Double(timeout), let tokens = Int(maxTokens) else {
            message = "间隔、超时和token上限必须为有效数字"; return
        }
        var config = HealthConfig()
        config.enabled = enabled; config.interval = interval; config.timeout = timeout
        config.prompt = prompt; config.maxTokens = tokens; config.targets = targets
        if controller.save(config) { load(controller.config); message = "检测设置已保存" }
        else { message = controller.message }
    }
}

struct ModelHealthSettingsView: View {
    @ObservedObject var controller: ModelHealthController
    @StateObject private var editor = HealthEditor()

    var body: some View {
        DisclosureGroup("检测设置与结果", isExpanded: $editor.expanded) {
        VStack(alignment: .leading, spacing: 8) {
            Text("开启会联网并可能收费；仅在应用运行时检测。无聊天历史或工具，最多并发2个，模型数量不限。")
                .font(.system(size: 10)).foregroundColor(.secondary)
            Toggle("启用检测（保存后生效）", isOn: $editor.enabled).toggleStyle(.checkbox)
            field("间隔秒数（10～86400）", $editor.interval)
            field("超时秒数（1～300）", $editor.timeout)
            field("测试口令", $editor.prompt)
            field("输出token上限（1～4096）", $editor.maxTokens)
            Text("极低预算可能无文本，此时标记未确认，不会自动加价重试。")
                .font(.system(size: 10)).foregroundColor(.secondary)
            ForEach(editor.targets) { target in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(target.source.isEmpty ? "未命名线路" : target.source) · \(target.model)").fontWeight(.medium).fixedSize(horizontal: false, vertical: true)
                    Text("\(target.protocolName) · \(target.endpoint)").font(.system(size: 10)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Toggle("启用此模型", isOn: Binding(get: {
                            editor.targets.first { $0.id == target.id }?.enabled ?? false
                        }, set: { enabled in
                            if let index = editor.targets.firstIndex(where: { $0.id == target.id }) { editor.targets[index].enabled = enabled }
                        })).toggleStyle(.checkbox)
                        Spacer()
                        Button("删除") { editor.targets.removeAll { $0.id == target.id } }
                    }
                }.padding(.vertical, 4)
                Divider()
            }
            Text("添加线路与模型").fontWeight(.medium)
            field("来源 / 账号标签", $editor.source)
            field("完整请求URL（含接口路径）", $editor.endpoint)
            Picker("协议", selection: $editor.protocolName) {
                Text("Chat Completions").tag("chat")
                Text("Responses").tag("responses")
                Text("Anthropic Messages").tag("anthropic")
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("API Key（不回显，仅存系统钥匙串）").font(.system(size: 10))
                SecureField("", text: $editor.apiKey).textFieldStyle(.roundedBorder)
            }
            Text("模型ID（一行一个，可批量）").font(.system(size: 10))
            TextEditor(text: $editor.models).font(.system(size: 11)).frame(height: 58)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
            Toggle("低推理模式（Chat / Responses）", isOn: $editor.reasoning).toggleStyle(.checkbox)
            field("输入单价 USD / 百万token（空=未知）", $editor.inputPrice)
            field("输出单价 USD / 百万token（空=未知）", $editor.outputPrice)
            Button("添加到待保存列表") { editor.add() }
            Text("已有线路修改请删除后重新添加。保存才生效。")
                .font(.system(size: 10)).foregroundColor(.secondary)
            HStack {
                Button("保存检测设置") { editor.save(controller) }.disabled(controller.storageFailed)
                Button("立即检测") { controller.check(); editor.message = controller.message }
            }
            Text(editor.message.isEmpty ? controller.message : editor.message).font(.system(size: 10)).fixedSize(horizontal: false, vertical: true)
            results
        }
        .font(.system(size: 11))
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if !editor.loaded { editor.load(controller.config) } }
        }
    }

    private func field(_ title: String, _ value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 10))
            TextField("", text: value).textFieldStyle(.roundedBorder)
        }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            Text(controller.config.enabled ? "检测已启用" : "检测已关闭").fontWeight(.medium)
            Text(String(format: "本次运行 %d 次 · 输入 %.0f / 输出 %.0f tokens", controller.stats.requests, controller.stats.input, controller.stats.output))
            Text(String(format: "估算 $%.6f · 用量未知 %d / 费用未知 %d 次", controller.stats.estimatedUSD, controller.stats.unknownUsage, controller.stats.unpriced))
            Text("费用按手填单价估算，非账单，重启清零。若中转日志也记录探测，普通遥测统计仍可能包含。")
                .font(.system(size: 10)).foregroundColor(.secondary)
            ForEach(controller.config.targets) { target in
                resultRow(target)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }

    private func resultRow(_ target: HealthTarget) -> some View {
        let result = controller.results[target.id]
        let stale = result?.checkedAt.map { Date().timeIntervalSince($0) > controller.config.interval } ?? false
        return VStack(alignment: .leading, spacing: 3) {
            Text("\(target.source) · \(target.model)").fontWeight(.medium)
            Text("\(target.enabled ? result?.state ?? "待检测" : "已停用")\(stale ? "（已过期）" : "")")
            if let result = result, let checked = result.checkedAt {
                Text("\(checked.formatted(date: .omitted, time: .standard)) · \(Int(result.latency))ms")
                Text("下次：\(result.nextAt == .distantFuture ? "鉴权暂停" : result.nextAt.formatted(date: .omitted, time: .standard))")
            }
            Button("检测此模型") { controller.check(target.id) }.disabled(!controller.config.enabled || !target.enabled)
            Divider()
        }.font(.system(size: 10)).fixedSize(horizontal: false, vertical: true)
    }
}
