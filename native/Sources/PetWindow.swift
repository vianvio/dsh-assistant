import AppKit

/// 宠物窗口：一块透明、无边框、所有 Space 可见、全屏应用之上也不掉的 NSPanel。
///
/// 这些标记缺一个都会“看起来能用但一全屏就没了”，所以集中在这里写清楚：
///   · .borderless + isOpaque=false + backgroundColor=.clear → 只有宠物本体可见
///   · .floating 层级 → 浮在普通窗口之上
///   · canJoinAllSpaces + fullScreenAuxiliary + stationary → 跟随所有桌面/全屏应用
///   · hidesOnDeactivate=false + orderFrontRegardless() → 切到别的 App 不被收起
/// 另外每 2 秒重新断言一次层级：某些系统面板（输入法、Dock 全屏）会把层级压回去。
final class PetWindow {
    let panel: NSPanel
    private let keepFrontTimer: Timer

    init(size: NSSize, origin: NSPoint) {
        panel = NSPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.animationBehavior = .none
        panel.title = "DSH Assistant"

        keepFrontTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak panel] _ in
            guard let panel else { return }
            // 只重设**层级**：某些系统面板（输入法、Dock 全屏）会把层级压回去。
            // 不要每 2 秒无条件 orderFrontRegardless() —— 那会把窗口反复"顶到最前"，
            // 在别的窗口之上表现为一下一下地闪（用户实测：切回 DSH 后一直闪）。
            if panel.level != .floating { panel.level = .floating }
            // 真的被收起来时（比如从"所有 Space 可见"里掉了）才需要重新上屏
            if !panel.isVisible { panel.orderFrontRegardless() }
        }
    }

    func show() {
        panel.orderFrontRegardless()
    }

    func setFrame(origin: NSPoint, size: NSSize) {
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    func close() {
        keepFrontTimer.invalidate()
        panel.orderOut(nil)
    }

    /// 兜底：任何忘记调 close() 的路径都不会留下一个永远每 2 秒
    /// `orderFrontRegardless()` 的定时器（它会把已经没人要的窗口一直顶上来）。
    deinit {
        keepFrontTimer.invalidate()
    }
}
