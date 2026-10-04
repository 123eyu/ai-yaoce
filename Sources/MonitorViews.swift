import SwiftUI

enum MetricLayoutProbe {
    static var frames: [String: CGRect] = [:]
    static var paceFrames: [String: CGRect] = [:]
}

struct PaceMarkerFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct MetricFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

struct MonitorTabs: View {
    @ObservedObject var store: Store

    var body: some View {
        HStack(spacing: 3) {
            ForEach(MonitorSource.allCases) { source in
                Button {
                    store.selectMonitorSource(source)
                } label: {
                    Text(source.title)
                        .font(Theme.label(11.5, store.monitorSource == source ? .semibold : .medium))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 7).fill(store.monitorSource == source
                            ? Color.accentColor.opacity(0.22) : Color.clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("source-\(source.rawValue)")
                .accessibilityAddTraits(store.monitorSource == source ? .isSelected : [])
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.045)))
    }
}

struct EqualMetricGrid<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(minimum: 0), spacing: Theme.gridSpacing),
                           GridItem(.flexible(minimum: 0), spacing: Theme.gridSpacing)],
                  spacing: Theme.gridSpacing) {
            content()
        }
    }
}

struct MetricSurface<Content: View>: View {
    let id: String
    let dark: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(12)
            .frame(height: Theme.metricCardHeight)
            .background(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                .fill(Color.primary.opacity(dark ? 0.065 : 0.045)))
            .clipped()
            .background(GeometryReader { geometry in
                Color.clear.preference(key: MetricFramesKey.self, value: [id: geometry.frame(in: .global)])
            })
    }
}

struct QuotaMetricCard: View {
    let window: QuotaWindow
    let dark: Bool
    var tips: TipBox?
    private var accent: Color { Theme.accent(window.severity, dark: dark).0 }

    var body: some View {
        MetricSurface(id: window.name, dark: dark) {
            VStack(alignment: .leading, spacing: 7) {
                Text(window.displayName)
                    .font(Theme.label(12, .semibold))
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .hoverTip(tips, window.displayName)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(Fmt.percent(window.usedPercent, precision: window.precision))
                        .font(Theme.mono(23, .bold)).foregroundStyle(accent)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    Text(L("已用", "used", "исп."))
                        .font(Theme.label(10)).foregroundStyle(.secondary)
                }
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(accent.opacity(0.2))
                        Capsule().fill(accent).frame(width: proxy.size.width * min(1, max(0, window.usedPercent / 100)))
                        if let pace = window.pacePercent, pace > 0.5, pace < 99.5 {
                            Rectangle()
                                .fill(Color.primary.opacity(dark ? 0.85 : 0.65))
                                .frame(width: 2, height: 10)
                                .offset(x: min(proxy.size.width - 2, proxy.size.width * pace / 100))
                                .background(GeometryReader { marker in
                                    Color.clear.preference(key: PaceMarkerFramesKey.self,
                                                           value: [window.name: marker.frame(in: .global)])
                                })
                        }
                    }.frame(height: 6)
                }.frame(height: 6)
                Text(L("剩余", "Left", "Осталось") + " " + String(format: "%.1f%%", window.remainingPercent))
                    .font(Theme.mono(10.5)).foregroundStyle(.secondary)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(L("重置", "Reset", "Сброс") + " " + Fmt.duration(window.resetAt.timeIntervalSince(context.date)))
                        .font(Theme.mono(10.5)).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("quota-\(window.name)")
    }
}

struct ClientMetricCard: View {
    let title: String
    let value: String
    let note: String
    let symbol: String
    let dark: Bool

    var body: some View {
        MetricSurface(id: title, dark: dark) {
            VStack(alignment: .leading, spacing: 8) {
                Label(title, systemImage: symbol)
                    .font(Theme.label(11.5, .semibold)).foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(value).font(Theme.mono(24, .bold))
                    .foregroundStyle(Color.accentColor)
                    .lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                Text(note).font(Theme.label(10.5)).foregroundStyle(.secondary)
                    .lineLimit(2).frame(height: 28, alignment: .bottomLeading)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct ClientMonitorView: View {
    @ObservedObject var store: Store
    let dark: Bool
    private var summary: ClientSummary { store.selectedClient }
    private var hasData: Bool { summary.weekRecords > 0 }
    private var amount: String {
        guard summary.pricedRecords > 0 else { return "—" }
        return String(format: "≈$%.2f", summary.estimatedUSD)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            EqualMetricGrid {
                ClientMetricCard(title: L("今日 token", "Today's tokens"),
                                 value: hasData ? Fmt.tokens(summary.todayTokens) : "—",
                                 note: L("输入、缓存与输出", "Input, cache and output"), symbol: "sun.max", dark: dark)
                ClientMetricCard(title: L("近 7 天 token", "7-day tokens"),
                                 value: hasData ? Fmt.tokens(summary.weekTokens) : "—",
                                 note: L("\(summary.sessions) 个本地会话", "\(summary.sessions) local sessions"), symbol: "calendar", dark: dark)
                ClientMetricCard(title: L("今日计量记录", "Usage records today"),
                                 value: hasData ? "\(summary.todayRecords)" : "—",
                                 note: L("用量事件，不等于对话轮数", "Usage events, not chat turns"), symbol: "chart.bar", dark: dark)
                ClientMetricCard(title: L("今日费用估算", "Est. cost today"), value: amount,
                                 note: summary.unpricedRecords > 0
                                    ? L("\(summary.unpricedRecords) 条缺价格，未计入", "\(summary.unpricedRecords) unpriced records excluded")
                                    : (summary.manualRecords > 0
                                       ? L("含自定义规则，非账单", "Custom rules applied, not a bill")
                                       : L("默认估算，非实际账单", "Default estimate, not a bill")), symbol: "dollarsign.circle", dark: dark)
            }

            if !hasData {
                Text(store.clientsRefreshing ? L("正在读取本地用量日志…", "Reading local usage logs…")
                     : L("暂无可计量的客户端日志。启动客户端完成一次调用后，点击刷新。", "No metered client logs. Complete a request in the client, then refresh."))
                    .font(Theme.label(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }

            if !summary.models.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(L("模型用量", "Model usage")).font(Theme.label(11.5, .semibold))
                        Spacer()
                        Text(L("近 7 天", "7 days")).font(Theme.label(10)).foregroundStyle(.secondary)
                    }
                    ForEach(Array(summary.models.prefix(store.detailsExpanded ? 12 : 3))) { model in
                        HStack(spacing: 8) {
                            Text(model.id).lineLimit(1).truncationMode(.middle).help(model.id)
                            Spacer(minLength: 0)
                            Text(Fmt.tokens(model.tokens)).font(Theme.mono(11, .medium))
                        }.font(Theme.label(11))
                    }
                }
                .padding(11)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(L("近 7 天：另有 \(summary.relayRecords) 条中转记录待关联", "7 days: \(summary.relayRecords) relay records remain unlinked"))
                    .font(Theme.label(10.5, .medium))
                Text(L("未重复相加 · 客户端记录含已识别的中转调用", "Not added twice · client records include identified relay usage"))
                    .font(Theme.label(10)).foregroundStyle(.secondary)
                Text(L("订阅剩余额度暂无可靠数据；不以 token 反推。", "Subscription quota unavailable; never inferred from tokens."))
                    .font(Theme.label(10)).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true)

            if !summary.warnings.isEmpty {
                Label(summary.warnings.joined(separator: "；"), systemImage: "exclamationmark.triangle")
                    .font(Theme.label(10.5)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                store.detailsExpanded.toggle()
            } label: {
                HStack {
                    Text(store.detailsExpanded ? L("收起来源与明细", "Hide source details") : L("来源与明细", "Source details"))
                    Spacer()
                    if summary.errors > 0 { Text(L("\(summary.errors) 条异常", "\(summary.errors) errors")).foregroundStyle(.orange) }
                    Image(systemName: store.detailsExpanded ? "chevron.up" : "chevron.down")
                }.font(Theme.label(11))
            }.buttonStyle(.plain)

            if store.detailsExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("本月 token：\(Fmt.tokens(summary.monthTokens))", "This month: \(Fmt.tokens(summary.monthTokens)) tokens"))
                    Text(summary.monthPricedRecords > 0
                         ? L("本月参考费用 ≈$\(String(format: "%.2f", summary.monthEstimatedUSD)) · \(summary.monthUnpricedRecords) 条未计价", "Month est. ≈$\(String(format: "%.2f", summary.monthEstimatedUSD)) · \(summary.monthUnpricedRecords) unpriced")
                         : L("本月参考费用：暂无价格", "Month estimated cost: no prices"))
                    Text(L("日志 provider：", "Log provider: ") + summary.providers.joined(separator: ", "))
                        .font(Theme.mono(10)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(L("客户端：\(summary.fileCount) 个日志文件 · 近 7 天 \(summary.weekRecords) 条计量记录", "Client: \(summary.fileCount) logs · \(summary.weekRecords) usage records in 7 days"))
                    Text(L("本机各客户端账号汇总，不按中转当前账号筛选。", "All local client accounts; not filtered by the current relay account."))
                    Text(L("其中 \(summary.managedRecords) 条来自受管会话，\(summary.matchedRecords) 条中转记录已按请求号关联。", "\(summary.managedRecords) managed records; \(summary.matchedRecords) relay records linked by request ID."))
                    Text(L("待关联中转 token：\(Fmt.tokens(summary.relayTokens))（不加入上方总量）", "Unlinked relay tokens: \(Fmt.tokens(summary.relayTokens)) (excluded above)"))
                    if !summary.relayModels.isEmpty { Text(summary.relayModels.joined(separator: " · ")).lineLimit(3) }
                    if let duration = summary.medianTurnSeconds {
                        Text(L("轮次耗时中位数 \(String(format: "%.1f", duration)) 秒（含工具执行，不是生成速度）", "Median turn \(String(format: "%.1f", duration))s including tools; not generation speed"))
                    }
                    if let latest = summary.latest { Text(L("最近记录", "Latest record") + " " + Fmt.clock(latest)) }
                    ForEach(Array(summary.recent.prefix(5))) { record in
                        HStack {
                            Text(record.model).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 2)
                            Text(record.failed ? L("异常", "Error") : Fmt.tokens(record.tokens.total))
                        }
                    }
                }
                .font(Theme.label(10.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }
}
