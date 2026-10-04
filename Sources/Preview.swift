import AppKit
import SwiftUI

/// 离屏渲染面板为 PNG。
///
/// 本机没有屏幕录制权限，`screencapture` 取不到画面，故走这条纯离屏的路
/// 来核对版面。用的是与运行时同一份视图代码和同一份真实数据，
/// 不是另画一张示意图。
enum Preview {
    static func verifyPricing() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configURL = directory.appendingPathComponent("prices.json")
        let editor = PricingEditor(url: configURL, preview: false)
        editor.source = "mirasim"; editor.model = "fixture-private-model"
        editor.input = "2"; editor.output = "4"; editor.read = "0"; editor.write = "0"
        guard editor.save() else { fatalError("Pricing editor save failed") }
        let now = Date()
        let row: [String: Any] = ["id": "fixture-pricing", "leg": "relay", "ts": ISO8601DateFormatter().string(from: now),
                                  "input": 1_000_000, "output": 1_000_000, "model": "fixture-private-model",
                                  "provider": "fixture-relay", "status": 200]
        let calendar = Calendar.current
        let name = String(format: "usage-%04d-%02d.ndjson", calendar.component(.year, from: now), calendar.component(.month, from: now))
        try JSONSerialization.data(withJSONObject: row).write(to: directory.appendingPathComponent(name))
        let ledger = CostLedger(insightsURL: directory, pricingURL: configURL)
        ledger.refresh()
        guard ledger.spent(since: now.addingTimeInterval(-60)).usd == 6 else { fatalError("Manual Mirasim pricing failed") }
        editor.edit(editor.config.rules[0]); editor.input = "0"; editor.output = "0"
        guard editor.save() else { fatalError("Zero price save failed") }
        ledger.refresh()
        let zero = ledger.spent(since: now.addingTimeInterval(-60))
        guard zero.usd == 0 && zero.count == 1 else { fatalError("Unchanged ledger was not repriced") }
        editor.edit(editor.config.rules[0]); editor.input = "-1"
        guard !editor.save(), editor.config.rules[0].prices["input"] == 0 else { fatalError("Invalid editor save mutated rules") }
        guard editor.remove(editor.config.rules[0]) else { fatalError("Delete failed") }
        ledger.refresh()
        guard ledger.unpricedCount(userId: nil) == 1 else { fatalError("Default missing-price state not restored") }
        let broken = PricingEditor(url: directory, preview: true)
        broken.model = "fixture"; broken.input = "1"
        guard !broken.save(), broken.config.rules.isEmpty else { fatalError("Failed disk save reported success") }
        let catalogURL = directory.appendingPathComponent("catalog.json")
        let partialCatalog: [String: Any] = ["data": ["fixture-relay": ["models": ["fixture-private-model": ["cost": ["input": 2, "output": 4]]]]]]
        try JSONSerialization.data(withJSONObject: partialCatalog).write(to: catalogURL)
        var cachedRow = row
        cachedRow["cacheRead"] = 100
        try JSONSerialization.data(withJSONObject: cachedRow).write(to: directory.appendingPathComponent(name))
        let partialLedger = CostLedger(insightsURL: directory, pricingURL: configURL, catalogURL: catalogURL)
        partialLedger.refresh()
        guard partialLedger.unpricedCount(userId: nil) == 1 else { fatalError("Missing cache price was guessed") }
        let cacheOnlyURL = directory.appendingPathComponent("cache-only.json")
        let cacheOnly: [String: Any] = ["data": ["anthropic": ["models": ["claude-sonnet-4": ["cost": ["cache_read": 0.3]]]]]]
        try JSONSerialization.data(withJSONObject: cacheOnly).write(to: cacheOnlyURL)
        cachedRow["model"] = "claude-sonnet-4"; cachedRow["provider"] = "anthropic"
        try JSONSerialization.data(withJSONObject: cachedRow).write(to: directory.appendingPathComponent(name))
        let cacheOnlyLedger = CostLedger(insightsURL: directory, pricingURL: configURL, catalogURL: cacheOnlyURL)
        cacheOnlyLedger.refresh()
        guard cacheOnlyLedger.unpricedCount(userId: nil) == 1 else { fatalError("Partial reference model incorrectly used builtin prices") }
        try Data("invalid".utf8).write(to: configURL)
        partialLedger.refresh()
        guard partialLedger.pricingWarning != nil else { fatalError("Invalid configuration was silently ignored") }
        let coldLedger = CostLedger(insightsURL: directory, pricingURL: configURL, catalogURL: catalogURL)
        coldLedger.refresh()
        guard coldLedger.pricingWarning != nil, coldLedger.spent(since: .distantPast).count == 0 else { fatalError("Invalid cold start configuration produced charges") }
        try PricingRules().save(to: configURL)
        partialLedger.refresh()
        guard partialLedger.pricingWarning == nil else { fatalError("Configuration recovery did not clear warning") }
        print("PASS: Mirasim missing cache price, corrupt configuration, cold start and recovery")
        print("PASS: pricing editor save/delete/validation/disk failure and Mirasim historical repricing including zero-cost calls")
    }

    /// 把菜单栏图标按几档用量并排画出来，核对配色与可读性。
    /// 菜单栏本身截不到（无屏幕录制权限），只能这样看。
    static func renderIcons(to path: String, dark: Bool) {
        let samples: [(Double, Bool)] = [(0.01, false), (0.25, false), (0.5, false),
                                         (0.7, false), (0.85, false), (1.0, false), (0.6, true)]
        let cell = NSSize(width: 62, height: 30)
        let canvas = NSView(frame: NSRect(x: 0, y: 0,
                                          width: cell.width * CGFloat(samples.count),
                                          height: cell.height))
        canvas.wantsLayer = true
        canvas.layer?.backgroundColor = dark
            ? NSColor(calibratedWhite: 0.13, alpha: 1).cgColor
            : NSColor(calibratedWhite: 0.93, alpha: 1).cgColor
        canvas.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)

        for (i, s) in samples.enumerated() {
            let iv = NSImageView(frame: NSRect(x: CGFloat(i) * cell.width + 6, y: 7,
                                               width: 16, height: 16))
            iv.image = StatusIcon.make(fraction: s.0, severity: s.0, stale: s.1)
            canvas.addSubview(iv)
            let label = NSTextField(labelWithString: s.1 ? "旧" : "\(Int(s.0 * 100))%")
            label.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
            label.textColor = dark ? .white : .black
            label.frame = NSRect(x: CGFloat(i) * cell.width + 24, y: 7, width: 36, height: 16)
            canvas.addSubview(label)
        }
        canvas.layoutSubtreeIfNeeded()
        guard let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds) else { return }
        canvas.cacheDisplay(in: canvas.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        print("已渲染菜单栏图标 \(path)")
    }

    /// 离屏渲染胶囊。
    static func renderCapsule(to path: String, dark: Bool, waitForData: TimeInterval) {
        let store = Store()
        let deadline = Date().addingTimeInterval(waitForData)
        while store.snapshot == nil && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
        }
        let settle = Date().addingTimeInterval(store.snapshot != nil ? 2.0 : 0.3)
        while Date() < settle {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }
        let host = NSHostingView(rootView: CapsuleView(store: store, onExpand: {}))
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        for _ in 0..<3 { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1)) }
        let pad: CGFloat = 18
        let canvas = NSView(frame: NSRect(x: 0, y: 0, width: host.frame.width + pad*2, height: host.frame.height + pad*2))
        canvas.wantsLayer = true
        canvas.layer?.backgroundColor = (dark ? NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.15, alpha: 1)
                                              : NSColor(calibratedWhite: 0.9, alpha: 1)).cgColor
        host.setFrameOrigin(NSPoint(x: pad, y: pad))
        canvas.addSubview(host)
        canvas.layoutSubtreeIfNeeded()
        for _ in 0..<2 { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1)) }
        guard let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds) else { return }
        canvas.cacheDisplay(in: canvas.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        print("已渲染胶囊 \(path)")
    }

    /// - Parameter waitForData: 最多等多久让真实额度到位。0 表示不等。
    static func render(to path: String, dark: Bool, expandDetail: Bool, waitForData: TimeInterval) {
        // 档位不跟用户偏好走（正式实例可能正开着小档），也不写偏好：
        // 默认标准档，--detail 为大档，环境变量 MT_SIZE=compact|standard|full 可指定。
        PanelSize.renderOverride = expandDetail ? .full
            : (PanelSize(rawValue: ProcessInfo.processInfo.environment["MT_SIZE"] ?? "") ?? .standard)
        let fixture = CommandLine.arguments.contains("--fixture")
        if fixture && CommandLine.arguments.contains("--pricing") {
            do { try verifyPricing() } catch { fatalError("Pricing verification failed: \(error)") }
        }
        let store = Store(startServices: !fixture)
        if fixture {
            store.loadPreviewFixture(empty: CommandLine.arguments.contains("--empty"), odd: CommandLine.arguments.contains("--odd"))
            let selected = store.monitorSource
            for source in MonitorSource.allCases {
                store.detailsExpanded = true
                store.settingsOpen = true
                store.selectMonitorSource(source)
                guard store.monitorSource == source, !store.detailsExpanded, !store.settingsOpen,
                      source == .mirasim || store.selectedClient.source == source else {
                    print("FAIL: source selection state")
                    exit(1)
                }
            }
            store.selectMonitorSource(selected)
            store.detailsExpanded = expandDetail
            print("PASS: three source selections isolate data and reset details/settings")
        }

        // 等真实数据。等不到就渲染空态——那本身也是要核对的一屏。
        let deadline = Date().addingTimeInterval(fixture ? 0 : waitForData)
        while store.snapshot == nil && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
        }
        // 数据到了再多跑几拍，让精确值合并进来、动画落定
        let settle = Date().addingTimeInterval(store.snapshot != nil ? 2.5 : 0.3)
        while Date() < settle {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }

        // --settings：渲染设置页核对版式
        if CommandLine.arguments.contains("--settings") { store.settingsOpen = true }
        let scale = fixture ? min(1.8, max(0.7, Double(ProcessInfo.processInfo.environment["MT_PREVIEW_SCALE"] ?? "1") ?? 1)) : 1
        let physicalLimit = fixture ? max(320, Double(ProcessInfo.processInfo.environment["MT_PREVIEW_HEIGHT"] ?? "760") ?? 760) : 760
        let view = PanelView(store: store, onRefresh: {}, onClose: {}, onToggleTop: {})
            .environment(\.panelHeightLimit, physicalLimit / scale)
        let natural: CGSize = {
            let measuringHost = NSHostingView(rootView: view)
            for _ in 0..<6 {
                measuringHost.frame = NSRect(origin: .zero, size: measuringHost.fittingSize)
                measuringHost.layoutSubtreeIfNeeded()
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
            }
            return measuringHost.fittingSize
        }()
        let root = scale == 1 ? AnyView(view) : AnyView(view.scaleEffect(scale, anchor: .topLeading)
            .frame(width: natural.width * scale, height: min(physicalLimit, natural.height * scale), alignment: .topLeading))
        let host = NSHostingView(rootView: root)
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let previewWindow = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        previewWindow.contentView = host
        defer { withExtendedLifetime(previewWindow) {} }
        host.layoutSubtreeIfNeeded()

        // 等版面稳定再截：账本、会话标题、速度配对都是异步到的，面板会边长边画。
        // 高度连续 2.4 秒不变才算稳定，最多再等 24 秒（机器忙时账本解析会慢）。
        // 至少多等 8 秒：账本大时速度栏与会话卡要几秒才到，先稳住的「半截版面」不能算稳定。
        var lastHeight = host.fittingSize.height, stableTicks = 0
        let settleStart = Date()
        for _ in 0..<75 {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.4))
            host.frame = NSRect(origin: .zero, size: host.fittingSize)
            host.layoutSubtreeIfNeeded()
            let h = host.fittingSize.height
            if abs(h - lastHeight) < 0.5 { stableTicks += 1 } else { stableTicks = 0; lastHeight = h }
            if stableTicks >= 6 && Date().timeIntervalSince(settleStart) >= (fixture ? 0 : 8) { break }
        }

        let initialCardFrames = MetricLayoutProbe.frames
        let initialPaceFrames = MetricLayoutProbe.paceFrames
        if fixture {
            if store.monitorSource == .mirasim, !store.settingsOpen, !store.sessions.isEmpty, store.showSessions {
                guard let sessionFrame = PanelViewportProbe.frames["sessions"], sessionFrame.height > 30 else {
                    fatalError("Sessions hidden when detailsExpanded=\(store.detailsExpanded)")
                }
                print("PASS: sessions visible independently of detailsExpanded=\(store.detailsExpanded)")
            }
            if CommandLine.arguments.contains("--scroll-bottom") {
                guard let scrollToBottom = PanelViewportProbe.scrollToBottom else {
                    fatalError("Scroll control was not attached")
                }
                scrollToBottom()
                for _ in 0..<5 {
                    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
                    host.layoutSubtreeIfNeeded()
                }
            }
            guard host.frame.height <= physicalLimit + 1,
                  let header = PanelViewportProbe.frames["header"],
                  let footer = PanelViewportProbe.frames["footer"],
                  let document = PanelViewportProbe.frames["content"] else {
                fatalError("Viewport exceeded height budget or missing measurements: \(host.frame.height)/\(physicalLimit)")
            }
            guard abs(header.minY) < 1, abs(footer.maxY - host.frame.height) < 1,
                  footer.minY > header.maxY else {
                fatalError("Header/footer not fixed inside host: \(header), \(footer)")
            }
            if CommandLine.arguments.contains("--scroll-bottom") {
                guard document.minY < header.maxY - 1,
                      abs(document.maxY - footer.minY) < 1 else {
                    fatalError("Cannot reach bottom of details: \(document), footer \(footer)")
                }
                print("PASS: scroll reaches content end, header/footer remain fixed")
            }
            print("PASS: bounded viewport \(host.frame.height) <= \(physicalLimit), document \(document.height), viewport \(footer.minY - header.maxY)")
        }

        // 面板是半透明的，底下垫一层模拟桌面，否则毛玻璃处渲染成全黑看不出效果
        let pad: CGFloat = 26
        let canvas = NSView(frame: NSRect(x: 0, y: 0,
                                          width: host.frame.width + pad * 2,
                                          height: host.frame.height + pad * 2))
        canvas.wantsLayer = true
        let bg = CAGradientLayer()
        bg.frame = canvas.bounds
        bg.colors = dark
            ? [NSColor(calibratedRed: 0.10, green: 0.11, blue: 0.14, alpha: 1).cgColor,
               NSColor(calibratedRed: 0.16, green: 0.14, blue: 0.20, alpha: 1).cgColor]
            : [NSColor(calibratedRed: 0.90, green: 0.91, blue: 0.94, alpha: 1).cgColor,
               NSColor(calibratedRed: 0.84, green: 0.86, blue: 0.91, alpha: 1).cgColor]
        bg.startPoint = CGPoint(x: 0, y: 0)
        bg.endPoint = CGPoint(x: 1, y: 1)
        canvas.layer?.addSublayer(bg)
        host.setFrameOrigin(NSPoint(x: pad, y: pad))
        canvas.addSubview(host)
        canvas.layoutSubtreeIfNeeded()

        previewWindow.setContentSize(canvas.frame.size)
        previewWindow.contentView = canvas
        for _ in 0..<3 {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.12))
        }

        guard let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds) else {
            FileHandle.standardError.write("无法建立离屏位图\n".data(using: .utf8)!)
            return
        }
        canvas.cacheDisplay(in: canvas.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: URL(fileURLWithPath: path))

        let state = store.snapshot.map {
            "窗口 \($0.windows.count) 个，口径 \($0.precision.label)"
        } ?? "无数据（空态）"
        if fixture, !store.settingsOpen, !(store.monitorSource == .mirasim && CommandLine.arguments.contains("--empty")) {
            let frames = Array(initialCardFrames.values)
            let expected = store.monitorSource == .mirasim && CommandLine.arguments.contains("--odd") ? 3 : 4
            guard frames.count == expected, let first = frames.first,
                  frames.allSatisfy({ abs($0.width - first.width) < 0.5 && abs($0.height - Theme.metricCardHeight * scale) < 0.5 }),
                  abs(first.width - (Theme.panelWidth - 28 - Theme.gridSpacing) / 2 * scale) < 0.5,
                  Set(frames.map { Int($0.minX.rounded()) }).count == 2,
                  Set(frames.map { Int($0.minY.rounded()) }).count == 2 else {
                print("FAIL: equal-grid geometry \(initialCardFrames)")
                exit(1)
            }
            print("PASS: \(expected) equal cards \(first.width)×\(first.height), 2 columns, panel \(host.frame.width)×\(host.frame.height)")
            if store.monitorSource == .mirasim, let snapshot = store.snapshot {
                let marked = snapshot.windows.filter { window in
                    guard let pace = window.pacePercent else { return false }
                    return pace > 0.5 && pace < 99.5
                }
                guard Set(initialPaceFrames.keys) == Set(marked.map(\.name)),
                      initialPaceFrames.values.allSatisfy({
                          abs($0.width - 2 * scale) < 0.5 && abs($0.height - 10 * scale) < 0.5
                      }) else {
                    fatalError("Missing or incorrectly sized quota pace markers: \(initialPaceFrames)")
                }
                print("PASS: \(marked.count) quota pace markers restored, 2×10 logical points")
            }
        }
        print("已渲染 \(path)（\(dark ? "深色" : "浅色")\(expandDetail ? " · 展开明细" : "")）— \(state)")
    }
}
