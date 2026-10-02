import AppKit

/// 宠物视图：负责绘制与鼠标交互，业务判断全部回调给 controller。
///
/// 可访问性：自绘内容对 VoiceOver 默认是不可见的，所以这里显式提供
/// accessibilityLabel/Value（dafeiyu 的原生窗口没有这一步，是本项目的加固点之一）。
final class PetView: NSView {
    weak var controller: PetController?

    private var grabOffset: NSPoint?
    private var windowOrigin: NSPoint?

    /// 宠物本体单独住一张子图层。
    ///
    /// 换帧不再走 `draw(_:)`：那条路要 AppKit 收集 display list、重画整个 backing store、
    /// 再提交一次 CA 事务（sample 里 `CA::Layer::display_if_needed` →
    /// `CABackingStoreUpdate_` → `CG::DisplayList::executeEntries` 就是它）。
    /// 换成 `layer.contents = 位图` 之后，换帧只是换一个图层的内容，
    /// CoreAnimation 直接在 GPU 侧合成，完全不经过这条路径。
    private let petLayer = CALayer()

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        // 本视图是 flipped（y 向下）；子图层默认 y 向上。打开几何翻转让两者一致 ——
        // 否则宠物会上下镜像。
        layer?.isGeometryFlipped = true
        petLayer.contentsGravity = .resize
        petLayer.magnificationFilter = .linear
        petLayer.minificationFilter = .linear
        petLayer.isOpaque = false
        layer?.addSublayer(petLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("PetView 只支持代码创建")
    }

    /// 换一帧：只更新图层内容和位置，不触发重绘。
    func updatePet(_ image: CGImage?, in rect: NSRect) {
        // 必须关掉隐式动画：不关的话每次换图 CALayer 都会插一次交叉淡入，
        // 白白多出一次 GPU 合成（看起来也会"糊"一下）。
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        petLayer.contents = image
        petLayer.frame = rect
        CATransaction.commit()
    }

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
