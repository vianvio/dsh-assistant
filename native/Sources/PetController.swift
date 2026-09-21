import AppKit
import QuartzCore

/// 宠物控制器：把协议消息、动画内核、窗口与绘制缝在一起。
///
/// 线程模型：stdin 读取在后台队列，所有 UI 变更都回到主线程串行执行，
/// 因此动画状态只有一个写入者，不需要锁。
///
/// 几何算式在 PetMetrics（纯逻辑，可单测），协议编解码在 PetProtocol ——
/// 这里只保留"需要真的有个窗口"的部分：生命周期、绘制、菜单、协议分发。
final class PetController: NSObject {
    // MARK: - 依赖

    private let manifest: PetManifest
    private let animation: PetAnimation
    private let frames: FrameStore
    private var window: PetWindow?
    private let view = PetView(frame: .zero)
    private let layout: PetLayoutStore
    /// 输出通道：生产走 stdout，自检可以换成内存缓冲
    private let channel: PetOutbound

    // MARK: - 配置（可被 config 消息与原生菜单修改）

    private var bubbleTheme: BubbleTheme = .light
    private var scale: Double
    private var bubbleEnabled: Bool
    private var reducedMotion: Bool
    private var soundEnabled: Bool
    private let canvasSize: NSSize

    /// 当前几何参数（scale / 气泡开关 / 配色 / 通知条数 → 一份不可变快照）
    private var metrics: PetMetrics {
        PetMetrics(
            scale: scale,
            bubbleEnabled: bubbleEnabled,
            theme: bubbleTheme,
            band: manifest.bubbleBand,
            noticeCount: animation.notices.count
        )
    }

    // MARK: - 位置

    private var petX: Double
    private var petY: Double
    private(set) var isDragging = false

    // MARK: - 循环

    private var tickTimer: Timer?
    private var lastTickAt = CACurrentMediaTime()

    // MARK: - 文案与总结

    /// 称呼：宿主在 hello 里给（`label`）。旧版两边字段名对不上（宿主发 label、
    /// 原生读 selfName），于是它一直停在默认值。
    private var selfName = "宠物"
    private var bubbleMessage: String?
    private var lastDrawnBubble: String?
    /// 「今天干了什么」的正文（本地持有，点通知/菜单打开弹窗）
    private var summaryTitle = "今天干了什么"
    private var summaryMarkdown = ""
    private let summaryWindow = PetSummaryWindow()

    private var lastDrawnClip: String?
    private var lastDrawnFrame: String?
    private var needsFullRedraw = true

    init(manifest: PetManifest, root: URL, layout: PetLayoutStore, channel: PetOutbound = StdoutChannel()) {
        self.manifest = manifest
        self.animation = PetAnimation(manifest: manifest)
        self.layout = layout
        self.channel = channel
        self.canvasSize = manifest.canvas
        self.frames = FrameStore(root: root, baseSize: canvasSize.width)

        let saved = layout.load()
        self.scale = saved?.scale ?? PetLayoutSnapshot.defaultScale
        self.bubbleEnabled = saved?.bubbleEnabled ?? true
        self.reducedMotion = saved?.reducedMotion ?? false
        self.soundEnabled = saved?.soundEnabled ?? false
        self.bubbleTheme = saved?.theme ?? .light
        let screen = NSScreen.main?.visibleFrame ?? PetMetrics.fallbackScreenFrame
        self.petX = saved?.x ?? (screen.maxX - canvasSize.width - 24)
        self.petY = saved?.y ?? (screen.minY + 24)

        super.init()
        view.controller = self
        animation.applyState(.idle, message: nil, detail: nil)
    }

    // MARK: - 生命周期

    func start() {
        // 初始尺寸走同一套计算（之前直接给 canvasSize，首帧会明显不对）
        window = PetWindow(size: windowSize(), origin: NSPoint(x: petX, y: petY))
        view.frame = NSRect(origin: .zero, size: canvasSize)
        window?.panel.contentView = view
        window?.panel.setAccessibilityLabel("DSH小助手")
        window?.show()
        // tick 的基准时间必须在窗口建好之后取：初始化与首个 tick 之间夹着
        // 素材解析、建窗、首帧解码，能差出几百毫秒甚至几秒 ——
        // 那段时间会被当成"已经过去"，第一帧直接跳格、通知也可能被瞬间判过期。
        lastTickAt = CACurrentMediaTime()
        scheduleTick()
        emit(["kind": "ready"])
    }

    func stop(reason: String) {
        tickTimer?.invalidate()
        tickTimer = nil
        window?.close()
        window = nil
        emit(["kind": "closed", "reason": reason])
    }

    // MARK: - 心跳循环

    /// 按当前片段的帧节奏安排下一次 tick（换片段时会重排）。
    ///
    /// 间隔跟着片段走：
    ///   · 静图段：250ms 一次（只处理到期 / IDLE 换图），几乎不耗电；
    ///   · 序列帧段：帧间隔的一半（如 30ms/帧 → 15ms 一次），
    ///     否则 250ms 的粗粒度会把 30ms 的帧一格一格吃掉，看起来更顿。
    private func scheduleTick() {
        tickTimer?.invalidate()
        let interval = tickInterval(for: animation.currentClip)
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        // .common 模式：拖动窗口 / 打开菜单时 run loop 切到事件跟踪模式，
        // 普通 .default 模式的定时器会停，宠物就卡住了。
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func tickInterval(for clip: PetManifest.Clip?) -> TimeInterval {
        guard clip?.isAnimated == true else { return 0.25 }
        return max(0.008, Double(clip?.frameMs ?? 90) / 2000.0)
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let elapsedMs = Int((now - lastTickAt) * 1000)
        lastTickAt = now
        let dirty = animation.advance(elapsedMs: elapsedMs)
        if let clip = animation.currentClip, clip.file != lastDrawnClip {
            lastDrawnClip = clip.file
            resizeForCurrentClip()
            needsFullRedraw = true
            if tickIntervalIsStale(for: clip) { scheduleTick() }
        }
        if let currentFile = animation.currentFrame?.file, currentFile != lastDrawnFrame {
            lastDrawnFrame = currentFile
            frames.prefetch(currentFile)
            if let next = animation.nextFrameFile { frames.prefetch(next) }
            needsFullRedraw = true
        }
        refreshBubble()
        // 只有换图 / 窗口变化 / 文案变化时才重绘，其余时间不重绘（省电）。
        // lastDrawnBubble 在这里收敛：文案变了就重绘一次并记下，下一 tick 条件即为假
        //（之前 refreshBubble 把旧值记进 lastDrawnBubble，导致这个条件**永远为真**，
        //  每个 tick 都在强制重绘）。
        if dirty || needsFullRedraw || bubbleMessage != lastDrawnBubble {
            needsFullRedraw = false
            lastDrawnBubble = bubbleMessage
            view.needsDisplay = true
        }
    }

    /// 当前 tick 间隔是否与片段的帧节奏不匹配（换片段后需要重排）。
    private func tickIntervalIsStale(for clip: PetManifest.Clip) -> Bool {
        guard let timer = tickTimer else { return true }
        return abs(timer.timeInterval - tickInterval(for: clip)) > 0.001
    }

    // MARK: - 窗口与位置

    private func windowSize() -> NSSize {
        metrics.windowSize(
            clip: animation.currentClip,
            canvas: canvasSize,
            message: bubbleMessage,
            detail: animation.bubbleDetail
        )
    }

    /// 换图时调整窗口：保持「底边中心」不动，只改尺寸 —— 宠物不会跳位置。
    private func resizeForCurrentClip() {
        guard let window else { return }
        let size = windowSize()
        let frame = window.panel.frame
        guard frame.size != size else { return }
        let originX = clampX(frame.midX - size.width / 2, width: size.width)
        let bottomY = frame.minY
        petX = Double(originX)
        petY = Double(bottomY)
        window.setFrame(origin: NSPoint(x: originX, y: bottomY), size: size)
        view.frame = NSRect(origin: .zero, size: size)
    }

    /// 位置重排（气泡文案变化 / 通知增减时用）。
    private func resizeWindow() {
        let size = windowSize()
        petX = Double(clampX(CGFloat(petX), width: size.width))
        petY = Double(clampY(CGFloat(petY), height: size.height))
        window?.setFrame(origin: NSPoint(x: petX, y: petY), size: size)
        view.frame = NSRect(origin: .zero, size: size)
        needsFullRedraw = true
    }

    /// 把 x 夹进"宠物完整可见"的范围。屏幕比窗口还窄时退回屏幕左边缘，
    /// 而不是算出比 minX 更小的值（那会把宠物整只推出屏幕）。
    private func clampX(_ value: CGFloat, width: CGFloat) -> CGFloat {
        let screen = screenVisibleFrame()
        let upper = max(screen.minX, screen.maxX - width)
        return min(max(value, screen.minX), upper)
    }

    private func clampY(_ value: CGFloat, height: CGFloat) -> CGFloat {
        let screen = screenVisibleFrame()
        let upper = max(screen.minY, screen.maxY - height)
        return min(max(value, screen.minY), upper)
    }

    /// 宠物所在的屏幕：优先"包含宠物当前位置的屏幕"，其次主屏。
    ///
    /// 不能用 `NSScreen.main`：对无边框非激活面板它可能返回 nil 或另一块屏，
    /// 于是"回到原位"会把宠物丢到屏幕外（实测 x=3168, y=-74）。
    private func screenVisibleFrame() -> NSRect {
        NSScreen.screens.first { $0.visibleFrame.contains(NSPoint(x: petX, y: petY)) }?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? PetMetrics.fallbackScreenFrame
    }

    /// 宠物所在的屏幕（按窗口相交判定，菜单/复位用）。
    private func currentScreen() -> NSScreen? {
        let frame = window?.panel.frame ?? .zero
        if frame.width > 0, let hit = NSScreen.screens.first(where: { $0.frame.intersects(frame) }) {
            return hit
        }
        return NSScreen.screens.first ?? NSScreen.main
    }

    /// 回到原位：当前屏幕的右下角、离边缘 24pt（菜单与宿主命令共用这一份实现）。
    /// 已经隐藏时也把窗口放回来 —— 否则「藏起来」就成了单向操作。
    private func resetToHomePosition() {
        window?.show()
        guard let screen = currentScreen() else { return }
        let visible = screen.visibleFrame
        let size = windowSize()
        let margin: CGFloat = 24
        let targetX = visible.maxX - size.width - margin
        let targetY = visible.minY + margin
        petX = Double(min(max(visible.minX, targetX), max(visible.minX, visible.maxX - size.width)))
        petY = Double(min(max(visible.minY, targetY), max(visible.minY, visible.maxY - size.height)))
        window?.setFrame(origin: NSPoint(x: petX, y: petY), size: size)
        needsFullRedraw = true
        persistLayout()
    }

    private func hidePet() {
        window?.panel.orderOut(nil)
    }

    /**
     把 DSH 应用本身带到前台。

     为什么必须由原生端做：**浏览器里的 JS 无权激活一个在后台的应用** ——
     macOS 的应用激活需要授权，而授权握在"用户刚刚点过的那个窗口"所属的进程手里，
     也就是这里（helper）。客户端那边只能 `window.focus()`，那只管应用内部的窗口。

     目标进程 = **父进程**：宿主插件跑在 DSH 的 Electron 主进程里，helper 由它 spawn
     （实测 helper 的 ppid 就是 Electron 主进程的 pid）。
     拿不到可激活的进程（headless / 父进程不是 GUI 应用）时安静跳过。
     */
    private func activateHostApp() {
        guard let host = NSRunningApplication(processIdentifier: getppid()) else { return }

        // ① 直接请求激活（macOS 14 起是协作式的：调用方在前台时才一定生效）
        if #available(macOS 14.0, *) {
            if host.activate() { return }
        } else if host.activate(options: [.activateAllWindows]) {
            return
        }

        // ② 兜底：交给 LaunchServices —— 等价于系统层面的"把这个 App 调到前台"
        //    （和点 Dock 图标同一套机制），不新建实例、只激活已在跑的那个。
        //
        //    为什么不只用 ①：宠物面板是 non-activating 的，点它**不会**让 helper 成为
        //    前台应用，所以 ① 可能被系统按协作规则拒绝；LaunchServices 这条路不依赖
        //    调用方是否在前台。
        guard let url = host.bundleURL else { return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error {
                FileHandle.standardError.write(
                    Data("dsh-assistant: 激活宿主应用失败: \(error)\n".utf8))
            }
        }
    }

    private func refreshBubble() {
        let next = bubbleEnabled ? animation.bubbleMessage : nil
        guard next != bubbleMessage else { return }
        bubbleMessage = next
        // 文案变了 → 气泡实测高度会变 → 窗口必须重排。
        // 漏这一步的症状：刚打开时窗口还是"没有气泡"的高度，气泡被压扁成一条
        // （绘制时会被 clamp 到 24pt），要等下一次换片段才恢复。
        resizeWindow()
        view.setAccessibilityValue(animation.accessibilitySummary)
        view.needsDisplay = true
    }

    // MARK: - 协议消息

    func apply(_ message: [String: Any]) {
        switch PetProtocol.stringValue(message["kind"]) ?? "" {
        case "hello":
            // 宿主在 hello 里给的是 label（旧版叫 selfName，两边曾经对不上）
            if let name = PetProtocol.stringValue(message["label"]) { selfName = name }
        case "state":
            let state = PetState(rawValue: PetProtocol.stringValue(message["state"]) ?? "") ?? .idle
            animation.applyState(state, message: PetProtocol.stringValue(message["message"]),
                                 detail: PetProtocol.stringValue(message["detail"]))
            if soundEnabled, state == .error { NSSound.beep() }
        case "pulse":
            let state = PetState(rawValue: PetProtocol.stringValue(message["state"]) ?? "") ?? .success
            animation.applyPulse(
                state: state,
                ttlMs: PetProtocol.intValue(message["ttlMs"]) ?? 2000,
                message: PetProtocol.stringValue(message["message"]),
                resumeState: PetState(rawValue: PetProtocol.stringValue(message["resumeState"]) ?? "")
            )
            if soundEnabled, state == .error || state == .success { NSSound.beep() }
        case "overlay":
            // 宿主发的互动浮层只带 action（pat/poke/feed/praise），不带具体片段名 ——
            // 曾经这里硬要求 clip，导致菜单里的"投喂点心/戳一下/夸夸它/摸摸头"全被丢掉。
            // 现在两种都收：有 clip 用 clip，只有 action 就从素材表里按动作挑一段。
            let clip = PetProtocol.stringValue(message["clip"])
            let action = PetProtocol.stringValue(message["action"])
            guard clip != nil || action != nil else { return }
            animation.applyOverlay(
                clip: clip,
                action: action,
                message: PetProtocol.stringValue(message["message"]),
                ttlMs: PetProtocol.intValue(message["ttlMs"]) ?? 2000
            )
        case "summary":
            handleSummary(message)
        case "notice":
            handleNotice(message)
        case "notice-clear":
            handleNoticeClear(message)
        case "config":
            applyConfig(message)
        case "command":
            handleCommand(PetProtocol.stringValue(message["action"]) ?? "")
        case "ping":
            emit(["kind": "pong"])
        case "shutdown":
            stop(reason: "host-shutdown")
            NSApp.terminate(nil)
        default:
            break
        }
        view.needsDisplay = true
    }

    private func applyConfig(_ message: [String: Any]) {
        if let value = PetProtocol.doubleValue(message["scale"]) { scale = min(2.0, max(0.15, value)) }
        if let value = message["bubbleEnabled"] as? Bool { bubbleEnabled = value }
        if let value = message["reducedMotion"] as? Bool {
            reducedMotion = value
            if value { frames.purge() }
        }
        if let value = message["soundEnabled"] as? Bool { soundEnabled = value }
        if let raw = PetProtocol.stringValue(message["bubbleTheme"]), let theme = BubbleTheme(rawValue: raw) {
            bubbleTheme = theme
        }
        resizeWindow()
        persistLayout()
    }

    /// 「今天干了什么」总结：正文留在本地，点通知/菜单即可打开弹窗。
    private func handleSummary(_ message: [String: Any]) {
        summaryTitle = PetProtocol.stringValue(message["title"]) ?? "今天干了什么"
        summaryMarkdown = PetProtocol.stringValue(message["markdown"]) ?? ""
        // 回执：宿主/探针据此确认消息真的到了（不是"发了但没人收"）
        emit(["kind": "interaction", "source": "host", "action": "summary-stored",
              "chars": summaryMarkdown.count])
    }

    private func openSummary() {
        guard !summaryMarkdown.isEmpty else {
            emit(["kind": "interaction", "source": "menu", "action": "summary-empty"])
            return
        }
        summaryWindow.present(title: summaryTitle, markdown: summaryMarkdown)
        emit(["kind": "interaction", "source": "menu", "action": "summary-opened",
              "panel": summaryWindow.debugInfo])
    }

    /// 处理完成通知相关的协议消息。
    private func handleNotice(_ message: [String: Any]) {
        let changed = animation.applyNotice(
            id: PetProtocol.stringValue(message["id"]) ?? "",
            project: PetProtocol.stringValue(message["project"]) ?? "会话",
            state: PetState(rawValue: PetProtocol.stringValue(message["state"]) ?? "") ?? .success,
            title: PetProtocol.stringValue(message["title"]) ?? "任务完成了",
            detail: PetProtocol.stringValue(message["detail"]) ?? "",
            // action 决定"点一下之后干什么"：open-summary = 打开总结弹窗，
            // 为空则只是"已查看"消失。**漏传这个字段就会点不开弹窗**（踩过）。
            action: PetProtocol.stringValue(message["action"]),
            sessionId: PetProtocol.stringValue(message["sessionId"])
        )
        guard changed else { return }
        resizeWindow()          // 通知带出现 → 窗口向上长，宠物位置不动
        needsFullRedraw = true
    }

    private func handleNoticeClear(_ message: [String: Any]) {
        let changed = animation.clearNotices(
            id: PetProtocol.stringValue(message["id"]),
            project: PetProtocol.stringValue(message["project"])
        )
        guard changed else { return }
        resizeWindow()
        needsFullRedraw = true
    }

    /// 宿主下发的命令。
    ///
    /// `home` / `hide` 是宿主（设置面板按钮）用的名字，`reset-position` 是菜单自己的叫法，
    /// 两者指向同一件事 —— 历史上只认后者，于是设置面板那两个按钮点了没反应。
    /// `where` 是排查用的自报坐标/尺寸，只给 `npm run probe -- --where` 用。
    private func handleCommand(_ action: String) {
        switch action {
        case "home", "reset-position":
            resetToHomePosition()
        case "hide":
            hidePet()
        case "open-summary":
            openSummary()
        case "where":
            emit(["kind": "interaction", "source": "probe", "action": "where", "position": positionSummary])
        default:
            break
        }
    }

    /// 供宿主/探针查询窗口位置、屏幕信息与**气泡实测尺寸**（排查定位/可读性问题用）。
    var positionSummary: [String: Any] {
        let screen = currentScreen()
        let size = windowSize()
        return [
            "x": petX,
            "y": petY,
            "scale": scale,
            "bubbleEnabled": bubbleEnabled,
            "bubbleTheme": bubbleTheme.rawValue,
            "bubbleScale": Double(metrics.bubbleScale),
            "bubbleBand": Double(metrics.bubbleBand),
            "bubbleMinWidth": Double(metrics.minimumBubbleWidth),
            "bubbleTitleFont": Double(metrics.titleFont.pointSize),
            "bubbleDetailFont": Double(metrics.detailFont.pointSize),
            "noticeRowHeight": Double(metrics.noticeRowHeight),
            "noticeCount": animation.notices.count,
            "windowWidth": Double(size.width),
            "windowHeight": Double(size.height),
            "screenCount": NSScreen.screens.count,
            "visibleFrame": screen.map { NSStringFromRect($0.visibleFrame) } ?? "nil",
        ]
    }

    // MARK: - 鼠标

    func beginDrag() { isDragging = true }

    func updateDrag() {
        guard let origin = window?.panel.frame.origin else { return }
        petX = Double(origin.x)
        petY = Double(origin.y)
    }

    func endDrag() {
        isDragging = false
        persistLayout()
    }

    func handleClick(at point: NSPoint, clickCount: Int) {
        // 先看是不是点在完成通知上 —— 点一下即视为「已查看」，通知消失并回报宿主
        for (notice, rect) in noticeRects() where rect.contains(point) {
            animation.clearNotices(id: notice.id)
            resizeWindow()
            // 三种点法都要回报 noticeId（宿主侧的通知账本才不会一直挂着）。
            // 具体是哪种由 Notice.clickAction 判断（纯逻辑，单测覆盖）。
            switch notice.clickAction {
            case .openSummary:
                openSummary()
                emit(["kind": "interaction", "source": "click", "action": "notice-open", "noticeId": notice.id])
            case .openSession(let sessionId):
                // 用户点通知的意图是"我要去看那个任务" → 先把 DSH 拉到前台，
                // 剩下的切会话交给宿主+客户端（它们才拿得到 DSH 的界面接口）
                activateHostApp()
                emit(["kind": "interaction", "source": "click", "action": "notice-open-session",
                      "noticeId": notice.id, "sessionId": sessionId])
            case .dismiss:
                emit(["kind": "interaction", "source": "click", "action": "notice-dismiss", "noticeId": notice.id])
            }
            return
        }

        let rect = petRect()
        // flipped 视图：point.y 越小越靠上，所以相对 y 直接用减法即可
        let relativeY = max(0, point.y - rect.minY)
        let relativeX = max(0, point.x - rect.minX)
        let zone: ClickZone
        if relativeY < rect.height * ClickZone.headRatio { zone = .head }
        else if relativeX > rect.width * ClickZone.tailRatio { zone = .tail }
        else { zone = .body }
        emit(["kind": "interaction", "source": "click", "zone": zone.rawValue, "clickCount": clickCount])
    }

    /// 悬浮窗分区（宿主把 head/tail 都映射成"摸头"，body 映射成"戳一下"）。
    enum ClickZone: String {
        case head
        case tail
        case body
        /// 上半部分算头（点击头部是主要互动方式）
        static let headRatio: CGFloat = 0.45
        /// 右侧 28% 算尾巴
        static let tailRatio: CGFloat = 0.72
    }

    // MARK: - 菜单

    func showMenu(with event: NSEvent) {
        guard let contentView = window?.panel.contentView else { return }
        NSMenu.popUpContextMenu(buildMenu(), with: event, for: contentView)
    }

    /// 右键菜单。设置项的状态都从当前配置读，改完立刻回写宿主（emitSettings）。
    private func buildMenu() -> NSMenu {
        let menu = NSMenu(title: selfName)

        let sizeMenu = NSMenu(title: "大小")
        for (label, value) in [("迷你 40%", 0.4), ("小 55%", 0.55), ("中 70%", 0.7), ("原尺寸 100%", 1.0)] {
            let item = NSMenuItem(title: label, action: #selector(changeScale(_:)), keyEquivalent: "")
            item.target = self
            item.tag = Int(value * 100)
            item.state = abs(scale - value) < 0.05 ? .on : .off
            sizeMenu.addItem(item)
        }
        menu.addItem(submenu("大小", sizeMenu))

        menu.addItem(checkable("显示气泡", #selector(toggleBubble(_:)), on: bubbleEnabled))

        let themeMenu = NSMenu(title: "气泡配色")
        for theme in BubbleTheme.allCases {
            let item = NSMenuItem(title: theme.menuTitle, action: #selector(changeBubbleTheme(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = theme.rawValue
            item.state = bubbleTheme == theme ? .on : .off
            themeMenu.addItem(item)
        }
        menu.addItem(submenu("气泡配色", themeMenu))

        menu.addItem(checkable("减少动效", #selector(toggleReducedMotion(_:)), on: reducedMotion))
        menu.addItem(checkable("提示音", #selector(toggleSound(_:)), on: soundEnabled))

        menu.addItem(.separator())

        for (label, action) in [("投喂点心", "feed"), ("戳一下", "poke"), ("夸夸它", "praise"), ("摸摸头", "pat")] {
            menu.addItem(interaction(label, action: action))
        }
        menu.addItem(interaction("今天干了什么", action: "summary-request"))

        let homeItem = NSMenuItem(title: "回到原位", action: #selector(resetPosition(_:)), keyEquivalent: "")
        homeItem.target = self
        menu.addItem(homeItem)

        menu.addItem(.separator())
        let hideItem = NSMenuItem(title: "本次隐藏", action: #selector(hidePet(_:)), keyEquivalent: "")
        hideItem.target = self
        menu.addItem(hideItem)
        return menu
    }

    private func submenu(_ title: String, _ submenu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        return item
    }

    private func checkable(_ title: String, _ action: Selector, on: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.state = on ? .on : .off
        return item
    }

    private func interaction(_ title: String, action: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(requestAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = action
        return item
    }

    @objc private func changeScale(_ sender: NSMenuItem) {
        scale = min(2.0, max(0.15, Double(sender.tag) / 100.0))
        resizeWindow()
        persistLayout()
        emitSettings(["scale": scale])
    }

    @objc private func toggleBubble(_ sender: NSMenuItem) {
        bubbleEnabled.toggle()
        refreshBubble()
        persistLayout()
        emitSettings(["bubbleEnabled": bubbleEnabled])
    }

    @objc private func changeBubbleTheme(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let theme = BubbleTheme(rawValue: raw) else { return }
        bubbleTheme = theme
        persistLayout()
        emitSettings(["bubbleTheme": theme.rawValue])
        view.needsDisplay = true
    }

    @objc private func toggleReducedMotion(_ sender: NSMenuItem) {
        reducedMotion.toggle()
        persistLayout()
        emitSettings(["reducedMotion": reducedMotion])
    }

    @objc private func toggleSound(_ sender: NSMenuItem) {
        soundEnabled.toggle()
        persistLayout()
        emitSettings(["soundEnabled": soundEnabled])
    }

    @objc private func requestAction(_ sender: NSMenuItem) {
        emit([
            "kind": "interaction",
            "source": "menu",
            "action": (sender.representedObject as? String) ?? "",
        ])
    }

    @objc private func resetPosition(_ sender: NSMenuItem) {
        resetToHomePosition()
    }

    @objc private func hidePet(_ sender: NSMenuItem) {
        hidePet()
    }

    // MARK: - 绘制

    /// 角色绘制矩形（没有图时退回整窗，保证点击判定不会崩）。
    private func petRect() -> NSRect {
        let metrics = self.metrics
        return metrics.petRect(
            bounds: view.bounds,
            clip: animation.currentClip,
            bubbleHeight: metrics.bubbleSize(
                message: bubbleMessage,
                detail: animation.bubbleDetail,
                outerWidth: view.bounds.width
            ).height
        )
    }

    func draw(in view: NSView) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(view.bounds)

        guard let frame = animation.currentFrame,
              let image = frames.image(for: frame.file) else { return }

        let rect = petRect()
        context.saveGState()
        // 本视图是 flipped（y 向下）；NSImage 直接画会被上下颠倒，
        // 所以先把这个矩形内的坐标系翻回 AppKit 常规方向（y 向上）。
        context.translateBy(x: 0, y: rect.maxY + rect.minY)
        context.scaleBy(x: 1, y: -1)
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
        context.restoreGState()

        // 气泡贴「这张图的头顶」而不是窗口顶
        let scaleFactor = image.size.height > 0 ? rect.height / image.size.height : 1
        drawBubble(above: rect.minY + frame.top * scaleFactor)

        // 完成通知单独画在最上方 —— 与状态气泡互不干扰
        drawNotices()
    }

    /// 双行气泡：第一行是当前动作/并行摘要，第二行是项目与各项目状态。
    ///
    /// 尺寸**只由 PetMetrics 算**（与窗口高度同源），这里只负责画 ——
    /// 两边各算一份的话，窗口按 A 留高度、气泡按 B 画，就会出现压扁或第二行被丢掉。
    private func drawBubble(above characterTop: CGFloat) {
        let metrics = self.metrics
        let message = bubbleMessage
        guard metrics.bubbleEnabled, let message, !message.isEmpty else { return }

        let detail = animation.bubbleDetail
        let outerWidth = view.bounds.width
        let size = metrics.bubbleSize(message: message, detail: detail, outerWidth: outerWidth)
        let rect = metrics.bubbleRect(size: size, outerWidth: outerWidth, characterTop: characterTop)
        let palette = metrics.theme.palette
        let titleAttributes: [NSAttributedString.Key: Any] = [.font: metrics.titleFont, .foregroundColor: palette.title]
        let detailAttributes: [NSAttributedString.Key: Any] = [.font: metrics.detailFont, .foregroundColor: palette.detail]

        let path = NSBezierPath(roundedRect: rect, xRadius: metrics.cornerRadius, yRadius: metrics.cornerRadius)
        palette.fill.setFill()
        path.fill()
        palette.stroke.setStroke()
        path.lineWidth = 1
        path.stroke()

        let textWidth = rect.width - metrics.textPadding * 2
        var cursorY = rect.minY + metrics.textPadding * 0.7
        (message as NSString).draw(
            in: NSRect(x: rect.minX + metrics.textPadding, y: cursorY, width: textWidth, height: metrics.titleFont.pointSize * 1.3),
            withAttributes: titleAttributes
        )
        cursorY += metrics.titleFont.pointSize * 1.3 + metrics.lineGap
        if let detail, cursorY + metrics.detailFont.pointSize * 1.3 <= rect.maxY {
            (detail as NSString).draw(
                in: NSRect(x: rect.minX + metrics.textPadding, y: cursorY, width: textWidth, height: metrics.detailFont.pointSize * 1.3),
                withAttributes: detailAttributes
            )
        }
    }

    // MARK: - 完成通知（独立一层，钉在宠物上方直到被查看）

    /// 通知栏每条的矩形（flipped 视图：y 越小越靠上）。
    /// 绘制与点击命中都用它，保证「看到的就是能点的」。
    func noticeRects() -> [(notice: PetAnimation.Notice, rect: NSRect)] {
        let notices = animation.notices
        let rects = metrics.noticeRects(ids: notices.map(\.id), viewWidth: view.bounds.width)
        return zip(notices, rects).map { (notice: $0, rect: $1) }
    }

    /// 单条通知卡片：左侧一条状态色竖条 + 标题 + 项目/阶段。
    private func drawNotices() {
        let rows = noticeRects()
        guard !rows.isEmpty else { return }
        let metrics = self.metrics
        let palette = metrics.theme.palette
        let radius = max(5, 8 * metrics.scale)

        for (notice, rect) in rows {
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            palette.fill.setFill()
            path.fill()
            palette.stroke.setStroke()
            path.lineWidth = 1
            path.stroke()

            // 状态色竖条：完成=绿，出错=红，等你确认=橙
            // （等你确认还没结束，比"完成"更需要人搭手，用最跳的颜色）
            let accent: NSColor
            switch notice.state {
            case .error: accent = .systemRed
            case .waiting: accent = .systemOrange
            default: accent = .systemGreen
            }
            accent.setFill()
            let bar = NSRect(x: rect.minX + 2, y: rect.minY + 3, width: max(3, 3.5 * metrics.bubbleScale),
                             height: rect.height - 6)
            NSBezierPath(roundedRect: bar, xRadius: bar.width / 2, yRadius: bar.width / 2).fill()

            let textX = bar.maxX + max(6, 8 * metrics.bubbleScale)
            let textWidth = rect.maxX - textX - metrics.noticePadding
            let titleHeight = metrics.titleFont.pointSize * 1.3
            let detailHeight = metrics.detailFont.pointSize * 1.3
            var cursorY = rect.minY + metrics.noticePadding * 0.7
            (notice.title as NSString).draw(
                in: NSRect(x: textX, y: cursorY, width: textWidth, height: titleHeight),
                withAttributes: [.font: metrics.titleFont, .foregroundColor: palette.title]
            )
            cursorY += titleHeight
            if !notice.detail.isEmpty {
                (notice.detail as NSString).draw(
                    in: NSRect(x: textX, y: cursorY, width: textWidth, height: detailHeight),
                    withAttributes: [.font: metrics.detailFont, .foregroundColor: palette.detail]
                )
            }
        }
    }

    var accessibilitySummary: String {
        let name = selfName
        if let message = bubbleMessage, !message.isEmpty { return "\(name)，\(animation.state.rawValue)，\(message)" }
        return "\(name)，\(animation.state.rawValue)"
    }

    // MARK: - 持久化与协议输出

    private func persistLayout() {
        layout.save(PetLayoutSnapshot(
            x: petX,
            y: petY,
            scale: scale,
            bubbleEnabled: bubbleEnabled,
            reducedMotion: reducedMotion,
            soundEnabled: soundEnabled,
            bubbleTheme: bubbleTheme.rawValue
        ))
    }

    private func emitSettings(_ payload: [String: Any]) {
        var message = payload
        message["kind"] = "settings"
        emit(message)
    }

    private func emit(_ payload: [String: Any]) {
        channel.send(payload)
    }
}
