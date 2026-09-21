import AppKit

/// 气泡配色：light = 浅底黑字，dark = 深底白字。
///
/// 值类型 + 顶层声明（不再藏在 controller 的 private enum 里）：
/// 菜单、持久化、协议三处都要在 String 与它之间转换，放在顶层只有这一处转换。
enum BubbleTheme: String, CaseIterable {
    case light
    case dark

    var menuTitle: String {
        switch self {
        case .light: return "浅色（黑字）"
        case .dark: return "深色（白字）"
        }
    }

    /// 气泡配色表：浅色 = 白底黑字，深色 = 黑底白字。
    var palette: BubblePalette {
        switch self {
        case .light:
            return BubblePalette(
                fill: NSColor(calibratedWhite: 1.0, alpha: 0.94),
                stroke: NSColor(calibratedWhite: 0.0, alpha: 0.10),
                title: NSColor(calibratedWhite: 0.08, alpha: 1.0),
                detail: NSColor(calibratedWhite: 0.36, alpha: 1.0)
            )
        case .dark:
            return BubblePalette(
                fill: NSColor(calibratedWhite: 0.09, alpha: 0.92),
                stroke: NSColor(calibratedWhite: 1.0, alpha: 0.18),
                title: NSColor(calibratedWhite: 0.97, alpha: 1.0),
                detail: NSColor(calibratedWhite: 0.72, alpha: 1.0)
            )
        }
    }
}

struct BubblePalette {
    let fill: NSColor
    let stroke: NSColor
    let title: NSColor
    let detail: NSColor
}

/// **气泡 / 通知 / 窗口的几何计算**（纯逻辑，无窗口、无绘制）。
///
/// 抽出来的原因：这些算式原本散在 controller 的十几处 getter 里，而**测量**与**绘制**
/// 各写了一份（字号、padding、gap、行高都抄了一遍）—— 两份一旦漂移，窗口高度就和
/// 实际画出来的气泡对不上（表现为气泡被压扁或第二行被悄悄丢掉）。
/// 现在只有这一份，绘制与测量取同一个 rect。
///
/// 所有数值都以 `scale = 1` 为基准再乘系数，改一档尺寸不用到处改常量。
struct PetMetrics {
    /// 气泡带基准高度（来自 manifest 的 bubbleBand；没有就按 84）。
    static let baseBand: CGFloat = 84
    static let baseMinWidth: CGFloat = 240
    static let baseTitleFont: CGFloat = 13
    static let baseDetailFont: CGFloat = 10.5
    /// 通知与状态气泡之间的固定间距（用户指定 8pt）
    static let noticeBubbleGap: CGFloat = 8
    /// 拿不到屏幕信息时的兜底可见区域（无头/异常环境）。
    static let fallbackScreenFrame = NSRect(x: 0, y: 0, width: 1512, height: 982)

    let scale: CGFloat
    let bubbleEnabled: Bool
    let theme: BubbleTheme
    let band: CGFloat
    /// 通知条数（决定窗口要向上长多少）
    let noticeCount: Int

    init(scale: Double, bubbleEnabled: Bool, theme: BubbleTheme, band: CGFloat = PetMetrics.baseBand, noticeCount: Int = 0) {
        self.scale = CGFloat(scale)
        self.bubbleEnabled = bubbleEnabled
        self.theme = theme
        self.band = max(34, band > 0 ? band : PetMetrics.baseBand)
        self.noticeCount = noticeCount
    }

    // MARK: - 缩放系数

    /// **气泡自己的缩放系数**：小尺寸下放大 1.5×，上限 1.0。
    ///
    /// 宠物可以缩到 40%，但气泡同比缩小就没法读了（13pt → 5.2pt）。
    /// 所以气泡的系数比宠物大胆：`min(1, scale × 1.5)` ——
    ///   迷你 40% → 0.60、小 55% → 0.825、≥70% → 1.0（不再放大）。
    var bubbleScale: CGFloat { min(1.0, scale * 1.5) }

    /// 气泡带高度（随气泡系数缩放，保证两行放得下）。
    var bubbleBand: CGFloat { max(34, band * bubbleScale) }

    /// 气泡最小宽度（小尺寸下也要放得下更长的文字）。
    var minimumBubbleWidth: CGFloat { max(180, Self.baseMinWidth * bubbleScale) }

    // MARK: - 字体与内边距（测量与绘制共用）

    var titleFont: NSFont { NSFont.systemFont(ofSize: max(10, Self.baseTitleFont * bubbleScale), weight: .semibold) }
    var detailFont: NSFont { NSFont.systemFont(ofSize: max(8.5, Self.baseDetailFont * bubbleScale), weight: .regular) }
    var textPadding: CGFloat { max(8, 10 * bubbleScale) }
    var lineGap: CGFloat { max(1.5, 2 * bubbleScale) }
    var horizontalInset: CGFloat { max(5, 7 * bubbleScale) }
    var cornerRadius: CGFloat { max(7, 11 * bubbleScale) }
    /// 宠物头顶到气泡下沿的间距
    var anchorGap: CGFloat { max(3, 6 * bubbleScale) }

    // MARK: - 通知层

    var noticePadding: CGFloat { max(6, 8 * bubbleScale) }
    var noticeGap: CGFloat { max(2, 4 * scale) }
    var noticeRowInset: CGFloat { max(6, 9 * scale) }

    /// 单条通知高度**按字体算**，不写死常量：
    /// 固定高度会让第二行（项目 · 阶段）溢出卡片边框（踩过）。
    var noticeRowHeight: CGFloat {
        ceil(titleFont.pointSize * 1.3 + detailFont.pointSize * 1.3 + noticePadding * 1.4)
    }

    /// 通知带高度：只算行本身 + 行间距（没有首尾多余空隙）。
    var noticeBand: CGFloat {
        guard noticeCount > 0 else { return 0 }
        return CGFloat(noticeCount) * noticeRowHeight + CGFloat(noticeCount - 1) * noticeGap
    }

    /// 通知层占用的总高度（含它与气泡之间的固定间距）；没有通知时为 0。
    var noticeBlock: CGFloat {
        noticeCount == 0 ? 0 : noticeBand + Self.noticeBubbleGap
    }

    // MARK: - 气泡

    /// 气泡的宽度上限（也是文字换行的依据）。
    func maxBubbleWidth(outerWidth: CGFloat) -> CGFloat {
        max(140, outerWidth - 2 * horizontalInset)
    }

    /// 气泡实测尺寸（关闭气泡 / 没有文案时为 .zero）。
    ///
    /// 宽度**显式传入**：用 view.bounds 会在"窗口还没按新尺寸重排"时量错，
    /// 文字换了行、高度却没变 → 气泡被压扁（首次打开时最容易撞上）。
    func bubbleSize(message: String?, detail: String?, outerWidth: CGFloat) -> NSSize {
        guard bubbleEnabled, let message, !message.isEmpty else { return .zero }
        let maxWidth = maxBubbleWidth(outerWidth: outerWidth)
        let textWidth = max(40, maxWidth - textPadding * 2)
        let titleSize = measure(message, font: titleFont, width: textWidth)
        let detailSize = detail.map { measure($0, font: detailFont, width: textWidth) } ?? .zero
        let width = min(maxWidth, max(titleSize.width, detailSize.width) + textPadding * 2)
        var height = titleSize.height + textPadding * 1.4
        if detailSize.height > 0 { height += detailSize.height + lineGap }
        return NSSize(width: ceil(width), height: ceil(height))
    }

    /// 气泡画在哪（flipped 视图坐标：y 越小越靠上）。
    ///
    /// 垂直：贴着角色上沿往上放（留 anchorGap），但不越出窗口上沿、也不低于 24pt，
    /// 免得被压成一条缝；水平：整窗居中 —— 与角色同轴才像"气泡在头上"。
    func bubbleRect(size: NSSize, outerWidth: CGFloat, characterTop: CGFloat) -> NSRect {
        let clampedHeight = min(size.height, max(24, characterTop - anchorGap - 2 - noticeBlock))
        return NSRect(
            x: (outerWidth - size.width) / 2,
            y: max(2, characterTop - anchorGap - clampedHeight),
            width: size.width,
            height: clampedHeight
        )
    }

    // MARK: - 窗口与角色

    /// 角色绘制矩形：底部对齐、水平居中、**按 scale 的真实尺寸**。
    ///
    /// 素材已经统一高度，所以这里不需要再算比例：宽度用 clip 记录的像素宽 × scale，
    /// 高度同理 —— 窄图不会被撑宽，宽图也不会被压缩（之前用固定矩形导致过变形）。
    func petRect(bounds: NSRect, clip: PetManifest.Clip?, bubbleHeight: CGFloat) -> NSRect {
        let width = min(bounds.width - 8, (clip?.width ?? bounds.width) * scale)
        let height = min(bounds.height - bubbleHeight - anchorGap - noticeBlock,
                         (clip?.height ?? bounds.height) * scale)
        return NSRect(x: bounds.midX - width / 2, y: bounds.maxY - height, width: width, height: height)
    }

    /// 窗口宽度：**跟着当前这张图走**（素材高度统一，所以高度也稳定）。
    /// 图里没有垫留白，窗口因此紧贴角色，透明区域不会白吃鼠标点击。
    func layoutWidth(clip: PetManifest.Clip?, canvas: NSSize) -> CGFloat {
        let imageW = (clip?.width ?? canvas.width) * scale
        return max(minimumBubbleWidth, imageW + 16 * scale)
    }

    /// 窗口尺寸 = 角色 + 间距 + 气泡实测 + 通知块。
    ///
    /// 之前窗口高度用的是一段**固定预留**（bubbleBand），气泡实际比它矮，多出来的空隙
    /// 就全堆在通知和气泡之间 —— 实测中间空了一大截。
    func windowSize(clip: PetManifest.Clip?, canvas: NSSize, message: String?, detail: String?) -> NSSize {
        let imageH = (clip?.height ?? canvas.height) * scale
        let layout = layoutWidth(clip: clip, canvas: canvas)
        // 先用目标宽度量一次（这一步不依赖窗口当前状态），再据此定窗口
        let bubble = bubbleSize(message: message, detail: detail, outerWidth: layout)
        return NSSize(
            width: max(layout, bubble.width + 16),
            height: imageH + anchorGap + bubble.height + noticeBlock
        )
    }

    /// 通知栏每条的矩形（flipped 视图：y 越小越靠上）。绘制与点击命中都用它，
    /// 保证「看到的就是能点的」。
    func noticeRects(ids: [String], viewWidth: CGFloat) -> [NSRect] {
        guard !ids.isEmpty else { return [] }
        let width = viewWidth - noticeRowInset
        var result: [NSRect] = []
        var y: CGFloat = 0
        for _ in ids {
            result.append(NSRect(x: noticeRowInset / 2, y: y, width: width, height: noticeRowHeight))
            y += noticeRowHeight + noticeGap
        }
        return result
    }

    private func measure(_ text: String, font: NSFont, width: CGFloat) -> NSSize {
        (text as NSString).boundingRect(
            with: NSSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        ).size
    }
}
