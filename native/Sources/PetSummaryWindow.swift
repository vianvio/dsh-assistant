import AppKit

/// 「今天干了什么」总结弹窗：只读 markdown + 一键复制全文。
///
/// 设计取舍：
///   · 用普通 `NSPanel`（带标题栏、可缩放、可关闭）而不是无边框透明窗 ——
///     阅读长文需要一个正常窗口：能拖、能缩、能 ⌘W 关掉；
///   · 层级用 `.floating`：宠物是浮层，总结窗也不该被普通窗口压住；
///   · **保留原始 markdown 字符串**：界面渲染成排版后的富文本，但复制按钮复制的是
///     原文（用户要拿去做日报/贴进文档，复制渲染结果会丢结构）。
final class PetSummaryWindow {
    private var panel: NSPanel?
    private var textView: NSTextView?
    private var rawMarkdown = ""
    private let copyButton = NSButton()

    /// 打开（或复用）总结窗并显示内容。
    func present(title: String, markdown: String) {
        rawMarkdown = markdown
        let panel = self.panel ?? makePanel()
        self.panel = panel

        panel.title = title.isEmpty ? "今天干了什么" : title
        textView?.textStorage?.setAttributedString(render(markdown))
        textView?.scrollToBeginningOfDocument(nil)
        copyButton.title = "复制 Markdown"

        // 先激活、再上浮：配件型进程的 activate 是异步的，顺序反了会把面板
        // 丢到另一个 Space 上去（用户看到的是"点了没反应"）。
        NSApp.activate(ignoringOtherApps: true)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
    }

    /// 诊断用：面板是否真的在屏幕上、什么位置。弹窗"不出现"时靠它定位原因。
    var debugInfo: [String: Any] {
        guard let panel else { return ["created": false] }
        return [
            "created": true,
            "visible": panel.isVisible,
            "frame": NSStringFromRect(panel.frame),
            "screenCount": NSScreen.screens.count,
            "alpha": panel.alphaValue,
            "level": panel.level.rawValue,
            "hidesOnDeactivate": panel.hidesOnDeactivate,
        ]
    }

    // MARK: - 构建

    private func makePanel() -> NSPanel {
        let size = NSSize(width: 620, height: 720)
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "今天干了什么"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        // NSPanel 默认 hidesOnDeactivate = true：我们这个 helper 是配件型进程、
        // 从不成为前台 App，面板一显示就被自动藏起来（踩过）。
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 380, height: 320)

        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.autoresizingMask = [.width, .height]

        // 顶部：标题 + 按钮
        let header = NSStackView()
        header.orientation = .horizontal
        header.spacing = 8
        header.edgeInsets = NSEdgeInsets(top: 10, left: 14, bottom: 6, right: 14)
        header.translatesAutoresizingMaskIntoConstraints = false
        header.distribution = .fill

        let heading = NSTextField(labelWithString: "今天干了什么")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        copyButton.title = "复制 Markdown"
        copyButton.bezelStyle = .rounded
        copyButton.target = self
        copyButton.action = #selector(copyAll)
        copyButton.keyEquivalent = "c"
        copyButton.keyEquivalentModifierMask = [.command, .shift]

        let closeButton = NSButton(title: "关闭", target: self, action: #selector(closeTapped))
        closeButton.bezelStyle = .rounded

        header.addArrangedSubview(heading)
        header.addArrangedSubview(spacer)
        header.addArrangedSubview(copyButton)
        header.addArrangedSubview(closeButton)

        // 正文：只读、可选中、可滚动
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.drawsBackground = true

        let text = NSTextView()
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = true
        text.backgroundColor = .textBackgroundColor
        text.textContainerInset = NSSize(width: 14, height: 12)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        scroll.documentView = text
        textView = text

        content.addSubview(header)
        content.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: content.topAnchor),
            header.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
        ])

        panel.contentView = content
        return panel
    }

    // MARK: - 渲染与复制

    /// markdown → 富文本。**自己解析，不用 `NSAttributedString(markdown:)`**。
    ///
    /// 原因：系统的 markdown 解析器会把整篇塌成一行（实测 `# 标题\n\n- 项` 解析后
    /// `.string` 里一个换行都没有），在文本视图里就变成一坨看不清的文字。
    /// 这里只实现报告会用到的语法子集，行为确定、排版稳定：
    ///   标题（#/##/###）、无序列表（- / *）、待办（- [ ] / - [x]）、
    ///   表格（| a | b | → 用 · 连接，表头加粗、跳过分隔行）、
    ///   行内 **加粗** 与 `代码`、空行留白。
    private func render(_ markdown: String) -> NSAttributedString {
        let baseSize: CGFloat = 13
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 2
        paragraph.paragraphSpacing = 2

        let result = NSMutableAttributedString()
        func append(_ text: String, font: NSFont, color: NSColor = .labelColor, spacing: CGFloat = 0) {
            let style = paragraph.mutableCopy() as! NSMutableParagraphStyle
            style.paragraphSpacing = spacing
            result.append(NSAttributedString(string: text + "\n", attributes: [
                .font: font, .foregroundColor: color, .paragraphStyle: style,
            ]))
        }

        func inline(_ text: String, font: NSFont) -> NSAttributedString {
            let output = NSMutableAttributedString()
            var buffer = ""
            var bold = false
            var code = false
            func flush() {
                guard !buffer.isEmpty else { return }
                var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor]
                if bold { attributes[.font] = NSFont.systemFont(ofSize: font.pointSize, weight: .semibold) }
                if code {
                    attributes[.font] = NSFont.monospacedSystemFont(ofSize: font.pointSize - 0.5, weight: .regular)
                    attributes[.foregroundColor] = NSColor.secondaryLabelColor
                }
                output.append(NSAttributedString(string: buffer, attributes: attributes))
                buffer = ""
            }
            let characters = Array(text)
            var index = 0
            while index < characters.count {
                let character = characters[index]
                if character == "*", index + 1 < characters.count, characters[index + 1] == "*" {
                    flush(); bold.toggle(); index += 2; continue
                }
                if character == "`" { flush(); code.toggle(); index += 1; continue }
                buffer.append(character)
                index += 1
            }
            flush()
            return output
        }

        // 表格块状态：离开表格行就重置，下一段表格的表头才认得出来
        var inTable = false

        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if !line.hasPrefix("|") { inTable = false }
            if line.isEmpty {
                append("", font: .systemFont(ofSize: baseSize * 0.5))
                continue
            }
            if line.hasPrefix("### ") {
                append(String(line.dropFirst(4)), font: .systemFont(ofSize: baseSize + 0.5, weight: .semibold), spacing: 3)
                continue
            }
            if line.hasPrefix("## ") {
                append(String(line.dropFirst(3)), font: .systemFont(ofSize: baseSize + 2, weight: .bold), spacing: 5)
                continue
            }
            if line.hasPrefix("# ") {
                append(String(line.dropFirst(2)), font: .systemFont(ofSize: baseSize + 4, weight: .bold), spacing: 8)
                continue
            }
            if line.hasPrefix("|") {
                // 表格：分隔行（|---|）跳过；其余用 · 连接单元格。
                // 表头 = 表格块的第一行（用 inTable 跟踪，不靠"文档里还没有换行"这种巧合）。
                let cells = line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                let content = cells.filter { !$0.isEmpty }
                if content.allSatisfy({ $0.allSatisfy { $0 == "-" || $0 == ":" } }) { continue }
                let isHeader = !inTable
                inTable = true
                let text = content.joined(separator: "  ·  ")
                let styled = NSMutableAttributedString(attributedString: inline(text, font: .systemFont(ofSize: baseSize)))
                if isHeader {
                    styled.addAttribute(.font, value: NSFont.systemFont(ofSize: baseSize, weight: .semibold),
                                        range: NSRange(location: 0, length: styled.length))
                }
                let style = paragraph.mutableCopy() as! NSMutableParagraphStyle
                style.headIndent = 10
                style.firstLineHeadIndent = 10
                styled.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: styled.length))
                result.append(styled)
                result.append(NSAttributedString(string: "\n"))
                continue
            }
            if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                let done = !line.hasPrefix("- [ ] ")
                let body = String(line.dropFirst(6))
                let mark = done ? "☑  " : "☐  "
                let styled = NSMutableAttributedString(string: mark, attributes: [
                    .font: NSFont.systemFont(ofSize: baseSize),
                    .foregroundColor: done ? NSColor.secondaryLabelColor : NSColor.labelColor,
                ])
                styled.append(inline(body, font: .systemFont(ofSize: baseSize)))
                let mutable = paragraph.mutableCopy() as! NSMutableParagraphStyle
                mutable.headIndent = 18
                mutable.firstLineHeadIndent = 2
                styled.addAttribute(.paragraphStyle, value: mutable, range: NSRange(location: 0, length: styled.length))
                result.append(styled)
                result.append(NSAttributedString(string: "\n"))
                continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                let body = String(line.dropFirst(2))
                let styled = NSMutableAttributedString(string: "•  ", attributes: [
                    .font: NSFont.systemFont(ofSize: baseSize), .foregroundColor: NSColor.secondaryLabelColor,
                ])
                styled.append(inline(body, font: .systemFont(ofSize: baseSize)))
                let style = paragraph.mutableCopy() as! NSMutableParagraphStyle
                style.headIndent = 16
                style.firstLineHeadIndent = 2
                styled.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: styled.length))
                result.append(styled)
                result.append(NSAttributedString(string: "\n"))
                continue
            }
            if line.hasPrefix("> ") {
                let styled = NSMutableAttributedString(string: "│ ", attributes: [
                    .font: NSFont.systemFont(ofSize: baseSize), .foregroundColor: NSColor.tertiaryLabelColor,
                ])
                styled.append(inline(String(line.dropFirst(2)), font: .systemFont(ofSize: baseSize)))
                styled.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor,
                                    range: NSRange(location: 0, length: styled.length))
                result.append(styled)
                result.append(NSAttributedString(string: "\n"))
                continue
            }
            let styled = NSMutableAttributedString(attributedString: inline(line, font: .systemFont(ofSize: baseSize)))
            let style = paragraph.mutableCopy() as! NSMutableParagraphStyle
            style.paragraphSpacing = 2
            styled.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: styled.length))
            result.append(styled)
            result.append(NSAttributedString(string: "\n"))
        }
        return result
    }

    @objc private func copyAll() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(rawMarkdown, forType: .string)
        // 明确反馈：按钮文字短暂变化，避免"到底复制成功没"
        copyButton.title = "已复制 ✓"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            self?.copyButton.title = "复制 Markdown"
        }
    }

    @objc private func closeTapped() {
        panel?.orderOut(nil)
    }
}
