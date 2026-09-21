import AppKit

/// 宠物视图：负责绘制与鼠标交互，业务判断全部回调给 controller。
///
/// 可访问性：自绘内容对 VoiceOver 默认是不可见的，所以这里显式提供
/// accessibilityLabel/Value（dafeiyu 的原生窗口没有这一步，是本项目的加固点之一）。
final class PetView: NSView {
    weak var controller: PetController?

    private var grabOffset: NSPoint?
    private var windowOrigin: NSPoint?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: - 可访问性

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
    override func accessibilityLabel() -> String? { "DSH小助手" }
    override func accessibilityValue() -> Any? { controller?.accessibilitySummary ?? "" }
    override func accessibilityHelp() -> String? { "拖动可移动位置，单击互动，右键打开菜单" }

    // MARK: - 鼠标

    override func mouseDown(with event: NSEvent) {
        windowOrigin = window?.frame.origin
        let mouse = NSEvent.mouseLocation
        grabOffset = NSPoint(x: mouse.x - (windowOrigin?.x ?? 0), y: mouse.y - (windowOrigin?.y ?? 0))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let grabOffset, let windowOrigin, let window else { return }
        let mouse = NSEvent.mouseLocation
        let next = NSPoint(x: mouse.x - grabOffset.x, y: mouse.y - grabOffset.y)
        if !(controller?.isDragging ?? false) {
            let manhattan = abs(next.x - windowOrigin.x) + abs(next.y - windowOrigin.y)
            if manhattan <= 4 { return }
            controller?.beginDrag()
        }
        window.setFrameOrigin(next)
        controller?.updateDrag()
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let clickCount = event.clickCount
        let wasDragging = controller?.isDragging ?? false
        grabOffset = nil
        windowOrigin = nil
        if wasDragging {
            controller?.endDrag()
        } else {
            controller?.handleClick(at: point, clickCount: clickCount)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        controller?.showMenu(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        controller?.draw(in: self)
    }
}
