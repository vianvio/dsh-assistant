import Foundation

/// 动画内核：纯逻辑、无 AppKit，可在 `swift test` 里直接验证。
///
/// **素材是静图就保持静态** —— 不做假动画；只有带序列帧（百炼生成的微动作）的
/// clip 才逐帧播放。这里负责：
///   1. **状态层**：七个耐久状态之一，决定用哪张图；
///   2. **脉冲层**：一次性的庆祝/报错，ttl 到期自动回落到状态；
///   3. **浮层**：互动动作（摸头/投喂…），优先级最高；
///   4. **同状态多张图随机挑**：进入状态时随机选，避开当前这张、也避开上次用过的；
///      长期停在 IDLE 时每 `idleRotateMs` 换一张，桌面不至于几个月都是同一张。
///
/// 换句话说：画面只在「状态/浮层变化」或「IDLE 轮换」时改变，其余时间完全静止。
final class PetAnimation {
    /// 完成通知：**独立于状态气泡**的一层。
    ///
    /// 为什么要有它：状态气泡表达的是「此刻在干什么」，多项目并行时会被
    /// 优先级更高的项目抢走（WAITING > ERROR > WORKING > …），所以"某个任务跑完了"
    /// 一旦被抢就没法在桌面上看到，用户只能切回 DSH。
    /// 通知钉在宠物上方，直到**被查看**（点一下 / 回到该项目 / 超时兜底）才消失。
    struct Notice: Equatable {
        let id: String
        let project: String
        let state: PetState
        let title: String
        let detail: String
        /// 点击后的动作：空 = 只是"已查看"就消失；`open-summary` = 打开总结弹窗。
        let action: String?
        /// 这条通知属于哪个会话 —— 点击时把它回报给宿主，由客户端切到那个会话。
        let sessionId: String?

        var clickAction: NoticeClick {
            if action == "open-summary" { return .openSummary }
            if let sessionId, !sessionId.isEmpty { return .openSession(sessionId) }
            return .dismiss
        }
    }

    /// 点击一条完成通知要做什么 —— 纯判断，放在内核里是为了能被 `npm run test:swift` 覆盖
    /// （PetController 需要真窗口，测不到这条分支）。
    enum NoticeClick: Equatable {
        /// 日报通知：本地打开总结弹窗
        case openSummary
        /// 普通完成通知：让宿主告诉客户端切到这个会话
        case openSession(String)
        /// 没有会话信息的：只当"已查看"
        case dismiss
    }

    struct Frame {
        let file: String
        /// 内容顶边（气泡据此贴合）。
        let top: CGFloat
    }

    /// 一层临时画面（脉冲 / 浮层）：到期时间用**模拟时钟**（advance 累计的毫秒），
    /// 和通知的过期口径一致 —— 用墙钟会出现"两份时间"，也会让测试无法驱动。
    private struct Layer {
        let clipName: String
        let message: String?
        let deadlineMs: Int
    }

    private let manifest: PetManifest
    /// 可注入的随机源：测试里固定住，行为可复现。
    private let random: () -> Double

    private(set) var state: PetState = .idle
    private(set) var stateMessage: String = ""
    private(set) var stateDetail: String = ""

    private var pulse: Layer?
    private var overlay: Layer?
    private(set) var clipName: String
    /// 序列帧播放位置（静图 clip 永远停在 0）
    private var frameIndex = 0
    private var frameElapsedMs = 0

    /// 完成通知（最新的在最前）
    private(set) var notices: [Notice] = []
    /// 同时最多显示几条（超出丢最旧的）
    var maxNotices: Int = 3
    /// 兜底过期：用户一直没看也不会永远堆着（默认 20 分钟）。
    /// 过期按 `advance(elapsedMs:)` 的模拟时间累计，和内核其它时间逻辑同一口径
    /// （用墙钟会让测试无法驱动，也会和帧播放节奏脱钩）。
    var noticeTtlMs: Int = 20 * 60 * 1000
    private var noticeAgeMs: [String: Int] = [:]

    /// IDLE 换图间隔（毫秒）；<=0 表示不换。
    var idleRotateMs: Int = 60000
    private var rotateAccumulatorMs = 0
    private var lastUsedByState: [PetState: String] = [:]
    /// 模拟时钟（毫秒）：脉冲/浮层的到期都以它为准，`advance` 是唯一的推进者。
    private var clockMs = 0

    init(manifest: PetManifest, random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.manifest = manifest
        self.random = random
        self.clipName = manifest.variants(forState: .idle).first ?? ""
    }

    // MARK: - 完成通知

    /// 收到一条完成通知：同一 id 覆盖，新的排在最前，超出上限丢最旧的。
    @discardableResult
    func applyNotice(id: String, project: String, state: PetState, title: String, detail: String,
                     action: String? = nil, sessionId: String? = nil) -> Bool {
        guard !id.isEmpty else { return false }
        notices.removeAll { $0.id == id }
        notices.insert(Notice(id: id, project: project, state: state, title: title, detail: detail,
                              action: action, sessionId: sessionId), at: 0)
        noticeAgeMs[id] = 0
        if notices.count > maxNotices {
            for dropped in notices.suffix(from: maxNotices) { noticeAgeMs[dropped.id] = nil }
            notices = Array(notices.prefix(maxNotices))
        }
        return true
    }

    /// 清除通知：给 id 清一条；给 project 清这个项目的全部；都不给就清所有。
    @discardableResult
    func clearNotices(id: String? = nil, project: String? = nil) -> Bool {
        let before = notices.count
        if let id, !id.isEmpty {
            notices.removeAll { $0.id == id }
        } else if let project, !project.isEmpty {
            notices.removeAll { $0.project == project }
        } else {
            notices.removeAll()
        }
        for id in noticeAgeMs.keys where !notices.contains(where: { $0.id == id }) {
            noticeAgeMs[id] = nil
        }
        return notices.count != before
    }

    /// 过期兜底（在 advance 里调用）：按模拟时间累计，超时就丢。
    private func expireNotices(elapsedMs: Int) -> Bool {
        guard noticeTtlMs > 0, !notices.isEmpty, elapsedMs > 0 else { return false }
        var expired: [String] = []
        for notice in notices {
            let age = (noticeAgeMs[notice.id] ?? 0) + elapsedMs
            noticeAgeMs[notice.id] = age
            if age > noticeTtlMs { expired.append(notice.id) }
        }
        guard !expired.isEmpty else { return false }
        for id in expired { noticeAgeMs[id] = nil }
        notices.removeAll { expired.contains($0.id) }
        return true
    }

    // MARK: - 状态变更

    func applyState(_ state: PetState, message: String?, detail: String?) {
        let changed = self.state != state
        self.state = state
        if let message { stateMessage = message }
        if let detail { stateDetail = detail }
        pulse = nil
        rotateAccumulatorMs = 0
        // 浮层还在时不抢画面，等它到期再切回状态底图
        guard overlay == nil else { return }
        if changed || clipName.isEmpty {
            _ = pickVariant(forState: state)
        }
    }

    func applyPulse(state: PetState, ttlMs: Int, message: String?, resumeState: PetState?) {
        guard ttlMs > 0 else { return }
        if let resumeState { self.state = resumeState }
        guard let chosen = pickVariant(forState: state, adopt: false) else { return }
        pulse = Layer(clipName: chosen, message: message, deadlineMs: clockMs + ttlMs)
        setClip(chosen)
    }

    func applyOverlay(clip: String? = nil, action: String? = nil, message: String?, ttlMs: Int) {
        guard ttlMs > 0 else { return }
        let candidates = clip.map { [$0] } ?? (action.map { manifest.variants(forAction: $0) } ?? [])
        guard let chosen = pick(from: candidates) else { return }
        overlay = Layer(clipName: chosen, message: message, deadlineMs: clockMs + ttlMs)
        setClip(chosen)
    }

    /// 时间推进：帧播放（仅序列帧 clip）+ 到期回落 + IDLE 换图。
    /// 返回是否发生需要重绘的变化（纯静图素材下几乎总是 false）。
    @discardableResult
    func advance(elapsedMs: Int) -> Bool {
        var dirty = false
        clockMs += max(0, elapsedMs)

        if expireNotices(elapsedMs: elapsedMs) { dirty = true }

        // 序列帧：只有带 frames 的 clip 才会走到这里
        if let clip = currentClip, clip.isAnimated, elapsedMs > 0 {
            frameElapsedMs += elapsedMs
            while frameElapsedMs >= clip.frameMs {
                frameElapsedMs -= clip.frameMs
                if frameIndex + 1 < clip.frames.count {
                    frameIndex += 1
                    dirty = true
                } else if clip.loop {
                    frameIndex = 0
                    dirty = true
                } else {
                    frameIndex = clip.frames.count - 1
                    frameElapsedMs = 0
                    break
                }
            }
        }

        if let layer = overlay, clockMs >= layer.deadlineMs {
            overlay = nil
            if let pulse {
                setClip(pulse.clipName)
            } else if let next = pickVariant(forState: state, adopt: false) {
                setClip(next)
            }
            dirty = true
        }
        if let layer = pulse, clockMs >= layer.deadlineMs {
            pulse = nil
            if overlay == nil, let next = pickVariant(forState: state, adopt: false) {
                clipName = next
                dirty = true
            }
        }

        if overlay == nil, pulse == nil, state == .idle, idleRotateMs > 0, elapsedMs > 0 {
            rotateAccumulatorMs += elapsedMs
            if rotateAccumulatorMs >= idleRotateMs {
                rotateAccumulatorMs = 0
                if pickVariant(forState: state, adopt: false) != nil { dirty = true }
            }
        }
        return dirty
    }

    // MARK: - 输出

    var currentClip: PetManifest.Clip? { manifest.clip(clipName) }

    var currentFrame: Frame? {
        guard let clip = currentClip else { return nil }
        if clip.isAnimated {
            let index = min(max(frameIndex, 0), clip.frames.count - 1)
            return Frame(file: clip.frames[index], top: clip.top)
        }
        return Frame(file: clip.file, top: clip.top)
    }

    /// 预读下一帧（只对序列帧有意义）。
    var nextFrameFile: String? {
        guard let clip = currentClip, clip.isAnimated else { return nil }
        let next = frameIndex + 1 < clip.frames.count ? frameIndex + 1 : (clip.loop ? 0 : frameIndex)
        return clip.frames[next]
    }

    /// 气泡第一行：浮层 > 脉冲 > 耐久状态。
    var bubbleMessage: String? {
        if let overlay, let message = overlay.message, !message.isEmpty { return message }
        if let pulse, let message = pulse.message, !message.isEmpty { return message }
        return stateMessage.isEmpty ? nil : stateMessage
    }

    /// 气泡第二行：项目 / 并行摘要。
    var bubbleDetail: String? {
        stateDetail.isEmpty ? nil : stateDetail
    }

    var accessibilitySummary: String {
        var parts = [state.label]
        if let message = bubbleMessage { parts.append(message) }
        if let detail = bubbleDetail { parts.append(detail) }
        return parts.joined(separator: "，")
    }

    // MARK: - 内部

    /// 从某个状态的素材里随机挑一张（避开当前这张与上次该状态用过的）。
    @discardableResult
    private func pickVariant(forState state: PetState, adopt: Bool = true) -> String? {
        let variants = manifest.variants(forState: state)
        guard !variants.isEmpty else { return nil }
        guard variants.count > 1 else {
            lastUsedByState[state] = variants[0]
            if adopt { setClip(variants[0]) }
            return variants[0]
        }
        let avoided = Set([clipName, lastUsedByState[state]].compactMap { $0 })
        let pool = variants.filter { !avoided.contains($0) }
        guard let chosen = pick(from: pool.isEmpty ? variants : pool) ?? variants.first else { return nil }
        lastUsedByState[state] = chosen
        if adopt { setClip(chosen) }
        return chosen
    }

    /// 换 clip：播放位置归零（同一段再次触发也从头播）。
    private func setClip(_ name: String) {
        frameIndex = 0
        frameElapsedMs = 0
        clipName = name
    }

    private func pick(from candidates: [String]) -> String? {
        let list = candidates.filter { manifest.clip($0) != nil }
        guard !list.isEmpty else { return nil }
        let raw = Int(random() * Double(list.count))
        return list[max(0, min(list.count - 1, raw))]
    }
}
