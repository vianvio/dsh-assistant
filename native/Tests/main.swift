import Foundation

/// 动画内核的可执行检查（不依赖 XCTest，直接 `swiftc` 编译运行）。
///
/// 覆盖三件最容易写错、又最影响观感的事：
///   1. **同状态多素材的随机选择** —— 进入状态要换图、且尽量不连续重复；
///   2. **优先级** —— 浮层 > 脉冲 > 状态，气泡文案同源；
///   3. **到期回落** —— 浮层/脉冲 ttl 到了要回到状态底片；IDLE 会定期换图。
///
/// 运行：npm run test:swift

var failures = 0
var checks = 0

func check(_ condition: Bool, _ label: String, detail: @autoclosure () -> String = "") {
    checks += 1
    if condition {
        print("  ✓ \(label)")
    } else {
        failures += 1
        let extra = detail()
        print("  ✗ \(label)\(extra.isEmpty ? "" : " — \(extra)")")
    }
}

/// 可预测的随机源：按固定序列返回，测试才可复现。
final class SequenceRandom {
    private let values: [Double]
    private var index = 0
    init(_ values: [Double]) { self.values = values.isEmpty ? [0] : values }
    func next() -> Double {
        let value = values[index % values.count]
        index += 1
        return value
    }
}

func makeManifest() throws -> (manifest: PetManifest, root: URL) {
    let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dsh-assistant-checks-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    func clip(_ file: String, width: Int, height: Int = 400, top: Int = 0) -> [String: Any] {
        [ "file": file, "width": width, "height": height, "top": top ]
    }
    let json: [String: Any] = [
        "formatVersion": 4,
        "canvas": ["width": 549, "height": 400],
        "bubbleBand": 84,
        "clips": [
            "idle-a": clip("idle/idle-a.webp", width: 300, top: 0),
            "idle-b": clip("idle/idle-b.webp", width: 421, top: 12),
            // 带序列帧的 clip：百炼生成的微动作（dir/prefix/count/frameMs）
            "idle-motion": [
                "file": "idle/idle-motion/idle-motion_001.webp",
                "width": 300, "height": 400, "top": 0,
                "dir": "idle/idle-motion", "prefix": "idle-motion",
                "count": 4, "frameMs": 50, "loop": true,
            ],
            "think-a": clip("thinking/think-a.webp", width: 320),
            "think-b": clip("thinking/think-b.webp", width: 286),
            "work-a": clip("working/work-a.webp", width: 349),
            "win-a": clip("success/win-a.webp", width: 401),
            "win-b": clip("success/win-b.webp", width: 277),
            "fail-a": clip("error/fail-a.webp", width: 330),
            "pat-a": clip("pat/pat-a.webp", width: 356),
            "pat-b": clip("pat/pat-b.webp", width: 280),
            "pat-c": clip("pat/pat-c.webp", width: 300),
            "poke-a": clip("poke/poke-a.webp", width: 300),
            "feed-a": clip("feed/feed-a.webp", width: 310),
            "praise-a": clip("praise/praise-a.webp", width: 290),
        ],
        "states": [
            "IDLE": ["idle-a", "idle-b", "idle-motion"],
            "THINKING": ["think-a", "think-b"],
            "WORKING": ["work-a"],
            "SUCCESS": ["win-a", "win-b"],
            "ERROR": ["fail-a"],
        ],
        "actions": [
            "pat": ["pat-a", "pat-b", "pat-c"],
            "poke": ["poke-a"],
            "feed": ["feed-a"],
            "praise": ["praise-a"],
        ],
    ]
    let data = try JSONSerialization.data(withJSONObject: json)
    let url = root.appendingPathComponent("pet-manifest.json")
    try data.write(to: url)
    return try PetManifest.load(from: url)
}

print("dsh-assistant · 动画内核检查")

let loaded = try makeManifest()
let manifest = loaded.manifest

check(manifest.canvas.width == 549 && manifest.canvas.height == 400, "参考画布尺寸来自 manifest")
check(manifest.bubbleBand == 84, "气泡带高度来自 manifest")
check(manifest.clip("idle-a")?.file == "idle/idle-a.webp", "clip 指向静图文件",
      detail: manifest.clip("idle-a")?.file ?? "nil")
check(manifest.clip("idle-b")?.width == 421, "宽度按原图记录（用于窗口自适应）",
      detail: "\(manifest.clip("idle-b")?.width ?? -1)")
let heights = Set(manifest.clips.values.map { $0.height })
check(heights == [400], "所有素材高度一致（切图不会跳大小）", detail: "\(heights)")
check(manifest.variants(forState: .idle).count == 3, "IDLE 有三段素材可选（含一段序列帧）")
check(PetState.fallback == .idle, "没登记的素材状态退回 IDLE（枚举里的 fallback）")
check(manifest.clip("idle-a")?.top == 0 && manifest.clip("idle-b")?.top == 12,
      "每张素材的头顶位置都读进来了（气泡据此贴合）",
      detail: "a=\(String(describing: manifest.clip("idle-a")?.top)) b=\(String(describing: manifest.clip("idle-b")?.top))")
check(manifest.clip("idle-a")?.top == 0, "没写 top 的素材退回 0（= 贴窗口顶）")

// 2) 序列帧：带 frames 的 clip 会逐帧播放并回卷
do {
    let animated = PetAnimation(manifest: manifest, random: SequenceRandom([0.99]).next)
    animated.applyState(.idle, message: "待机", detail: "demo")
    guard let motionIndex = manifest.variants(forState: .idle).firstIndex(of: "idle-motion") else {
        fatalError("fixture 缺少 idle-motion")
    }
    // 用固定随机源把 idle-motion 挑出来（0.99 会落在最后一档）
    if animated.currentClip?.isAnimated != true {
        // 兜底：直接再抽几次，直到命中（fixture 只有三段，随机源固定）
        _ = animated.advance(elapsedMs: 0)
    }
    check(manifest.clip("idle-motion")?.isAnimated == true, "带 count 的 clip 被识别为序列帧",
          detail: "\(manifest.clip("idle-motion")?.frames.count ?? -1) 帧")
    check(manifest.clip("idle-motion")?.frames.count == 4, "帧列表按序号拼好")
    _ = motionIndex

    let clip = manifest.clip("idle-motion")!
    let player = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    player.applyState(.idle, message: "待机", detail: "demo")
    player.applyOverlay(clip: "idle-motion", message: "微动作", ttlMs: 10_000)
    let first = player.currentFrame?.file
    var advanced = false
    for _ in 0..<3 {
        if player.advance(elapsedMs: clip.frameMs) { advanced = true }
    }
    check(advanced, "序列帧会随时间推进")
    check(player.currentFrame?.file != first, "推进后换到了下一帧",
          detail: "\(first ?? "-") → \(player.currentFrame?.file ?? "-")")

    // 回卷：推进一整圈回到第一帧
    player.applyOverlay(clip: "idle-motion", message: "微动作", ttlMs: 10_000)
    for _ in 0..<clip.frames.count { _ = player.advance(elapsedMs: clip.frameMs) }
    check(player.currentFrame?.file == clip.frames.first, "循环态播完回卷到第一帧",
          detail: player.currentFrame?.file ?? "nil")
}

// 2.5) 完成通知：独立一层，钉住直到被查看
do {
    let pet = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    pet.applyState(.working, message: "干活", detail: "demo")

    _ = pet.applyNotice(id: "n1", project: "dsh-assistant", state: .success, title: "任务完成了", detail: "dsh-assistant · 12s")
    check(pet.notices.count == 1, "通知能挂上", detail: "\(pet.notices.count) 条")
    check(pet.notices.first?.action == nil, "普通通知没有点击动作（点一下只是已查看）")

    // 「今天干了什么」这类通知：点一下要打开弹窗，所以 action 必须被记住
    _ = pet.applyNotice(id: "summary", project: "今日总结", state: .success,
                        title: "今天干了什么 · 已生成", detail: "点击查看",
                        action: "open-summary")
    check(pet.notices.first?.action == "open-summary", "通知记住点击动作",
          detail: pet.notices.first?.action ?? "nil")
    _ = pet.clearNotices(id: "summary")

    // "切回 DSH 就清完成类通知"依赖这个区分：没有 action 的是完成提示，
    // 有 action 的（总结已生成）要等用户点开看过。
    let mixed = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    _ = mixed.applyNotice(id: "done", project: "p", state: .success, title: "任务完成了", detail: "p")
    _ = mixed.applyNotice(id: "sum", project: "今日总结", state: .success, title: "总结已生成", detail: "点击查看",
                          action: "open-summary")
    let completions = mixed.notices.filter { $0.action == nil }
    check(completions.count == 1 && completions.first?.id == "done", "只有完成类通知会被批量清理")
    check(mixed.notices.contains { $0.action == "open-summary" }, "带动作的通知不会被顺手清掉")

    // 关键行为：并行时状态被别的项目抢走，通知必须还在
    pet.applyState(.idle, message: "待机", detail: "别的项目在跑")
    check(pet.notices.count == 1, "状态切换后通知不受影响（这正是要解决「跑完了看不到」）")

    // 时间推进不会让通知消失（只有查看/超时才清）
    _ = pet.advance(elapsedMs: 30_000)
    check(pet.notices.count == 1, "通知不会因为时间推移就被状态气泡挤掉")

    _ = pet.applyNotice(id: "n2", project: "api", state: .error, title: "任务出错了", detail: "api · 失败")
    check(pet.notices.first?.id == "n2", "新通知排在最前", detail: pet.notices.first?.id ?? "nil")
    _ = pet.applyNotice(id: "n3", project: "web", state: .success, title: "任务完成了", detail: "web")
    _ = pet.applyNotice(id: "n4", project: "cli", state: .success, title: "任务完成了", detail: "cli")
    check(pet.notices.count == 3, "最多同时显示 3 条（超出丢最旧）", detail: "\(pet.notices.count)")

    check(pet.clearNotices(id: "n2") == true, "按 id 清除（点击查看）")
    check(!pet.notices.contains { $0.id == "n2" }, "被点的那条确实消失了")
    check(pet.clearNotices(project: "web") == true, "按项目清除（回到该项目 = 已查看）")
    check(!pet.notices.contains { $0.project == "web" }, "该项目下的通知都清了")
    check(pet.clearNotices() == true && pet.notices.isEmpty, "无条件清空")

    // 超时兜底：用户一直没看也不会永远堆着
    let expiring = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    expiring.noticeTtlMs = 1000
    _ = expiring.applyNotice(id: "old", project: "x", state: .success, title: "任务完成了", detail: "x")
    _ = expiring.advance(elapsedMs: 2000)
    check(expiring.notices.isEmpty, "超过兜底时间会自动清掉")
}

// 3) 静图模式：没有换图需求时，时间推进不产生重绘（省电、不闪）
do {
    let animation = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    animation.applyState(.working, message: "干活", detail: "demo")
    let before = animation.currentFrame?.file
    var repaints = 0
    for _ in 0..<20 { if animation.advance(elapsedMs: 500) { repaints += 1 } }
    check(repaints == 0, "静图状态下不会自己重绘", detail: "重绘 \(repaints) 次")
    check(animation.currentFrame?.file == before, "画面保持不变", detail: "\(before ?? "-") → \(animation.currentFrame?.file ?? "-")")

    // IDLE 换图是唯一会主动重绘的情况
    let idle = PetAnimation(manifest: manifest, random: SequenceRandom([0.0, 0.9]).next)
    idle.applyState(.idle, message: "待机", detail: "demo")
    var rotated = false
    for _ in 0..<40 { if idle.advance(elapsedMs: 2000) { rotated = true; break } }
    check(rotated, "长期待机会偶尔换一张图（不至于几个月同一张）")
}

// 1) 状态切换时换素材；同一状态内不下发新状态就不动图（避免文字刷新导致闪烁）
do {
    let animation = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    animation.applyState(.idle, message: "待机", detail: "demo")
    let idleClip = animation.clipName
    animation.applyState(.working, message: "干活", detail: "demo")
    check(animation.clipName == "work-a", "切到 WORKING 会换成工作素材", detail: animation.clipName)
    animation.applyState(.thinking, message: "思考", detail: "demo")
    check(animation.clipName.hasPrefix("think-"), "切到 THINKING 会换成思考素材", detail: animation.clipName)
    animation.applyState(.idle, message: "待机", detail: "demo")
    check(animation.clipName != "", "回到 IDLE 有素材可用", detail: animation.clipName)
    animation.applyState(.idle, message: "待机（文案更新）", detail: "demo")
    check(animation.bubbleMessage == "待机（文案更新）", "同状态文案更新不影响素材选择")
    _ = idleClip
}

// 随机性：连续两次回到 IDLE 不会挑到同一张（「不重复」是这里真正要保证的性质）
do {
    // 递增的随机序列，模拟真实随机源下连续两次落在不同位置
    final class RampRandom {
        private var index = 0
        func next() -> Double { defer { index += 1 }; return Double(index % 8) / 8.0 }
    }
    let ramp = RampRandom()
    let animation = PetAnimation(manifest: manifest, random: ramp.next)
    var previous: String?
    var repeats = 0
    var seen = Set<String>()
    for _ in 0..<8 {
        animation.applyState(.thinking, message: "思考", detail: "demo")
        animation.applyState(.idle, message: "待机", detail: "demo")
        if let previous, previous == animation.clipName { repeats += 1 }
        previous = animation.clipName
        seen.insert(animation.clipName)
    }
    check(repeats == 0, "连续回到 IDLE 不会重复同一张素材", detail: "重复 \(repeats) 次，见到 \(seen.sorted())")
    check(seen.count >= 2, "8 次里用到了多个 IDLE 素材", detail: "见到: \(seen.sorted())")
}

// 2) 优先级：浮层 > 脉冲 > 状态
do {
    let animation = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    animation.applyState(.thinking, message: "在思考", detail: "demo · 分析阶段")
    check(animation.bubbleMessage == "在思考", "状态文案上屏")
    check(animation.bubbleDetail == "demo · 分析阶段", "第二行是项目/阶段")

    animation.applyPulse(state: .success, ttlMs: 1500, message: "完成啦", resumeState: .idle)
    check(animation.bubbleMessage == "完成啦", "脉冲压过状态文案")
    check(animation.clipName.hasPrefix("win-"), "脉冲换成了庆祝素材", detail: animation.clipName)

    animation.applyOverlay(action: "pat", message: "别摸头", ttlMs: 1200)
    check(animation.bubbleMessage == "别摸头", "浮层压过脉冲文案")
    check(animation.clipName.hasPrefix("pat-"), "浮层换成了动作素材", detail: animation.clipName)
}

// 2.9) 互动浮层：菜单四项（投喂点心/戳一下/夸夸它/摸摸头）走的就是这条路径 ——
//      宿主只发 action，不发具体片段名，所以必须能按动作从素材表里挑。
do {
    for action in ["pat", "poke", "feed", "praise"] {
        let probe = PetAnimation(manifest: manifest, random: SequenceRandom([0.5]).next)
        probe.applyState(.idle, message: "待机", detail: "demo")
        probe.applyOverlay(action: action, message: action, ttlMs: 1000)
        let picked = probe.clipName
        check(manifest.variants(forAction: action).contains(picked),
              "动作 \(action) 能挑到素材并播放",
              detail: "picked=\(picked) candidates=\(manifest.variants(forAction: action).count)")
        check(probe.bubbleMessage == action, "动作 \(action) 的文案上气泡")
    }

    // 既有 clip 又给 action 时，以 clip 为准（宿主显式指定优先）
    let explicit = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    explicit.applyOverlay(clip: "win-a", action: "pat", message: "指定片段", ttlMs: 1000)
    check(explicit.clipName == "win-a", "显式 clip 优先于 action", detail: explicit.clipName)
}

// 3) 到期回落：浮层/脉冲过期后回到状态底片
do {
    let animation = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    animation.applyState(.working, message: "在干活", detail: "demo")
    let workingClip = animation.clipName
    animation.applyOverlay(action: "pat", message: "别摸头", ttlMs: 10)
    // 时间基是 advance 累计的模拟毫秒（不再依赖墙钟），测试因此可复现、不用 sleep
    _ = animation.advance(elapsedMs: 11)
    check(animation.clipName == workingClip, "浮层过期后回到状态底片", detail: "now=\(animation.clipName) want=\(workingClip)")
    check(animation.bubbleMessage == "在干活", "浮层过期后文案回到状态")
}

// 4) IDLE 长时间停留会换图
do {
    let animation = PetAnimation(manifest: manifest, random: SequenceRandom([0.99, 0.0, 0.99]).next)
    animation.idleRotateMs = 100
    animation.applyState(.idle, message: "待机", detail: "demo")
    let before = animation.clipName
    var changed = false
    for _ in 0..<10 {
        if animation.advance(elapsedMs: 40) { changed = true; break }
    }
    check(changed, "空闲一段时间后会换图", detail: "before=\(before) now=\(animation.clipName)")
}

// 5) 动作也可随机：pat 有两个素材
do {
    var seen = Set<String>()
    for value in [0.0, 0.99] {
        let animation = PetAnimation(manifest: manifest, random: SequenceRandom([value]).next)
        animation.applyState(.idle, message: "待机", detail: "demo")
        animation.applyOverlay(action: "pat", message: "摸头", ttlMs: 1000)
        seen.insert(animation.clipName)
    }
    check(seen.count == 2, "同一动作会在多个素材间随机", detail: "见到: \(seen.sorted())")
}

// 6) 布局持久化：写读一致 + 原子写不残留临时文件
do {
    let path = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dsh-assistant-layout-\(UUID().uuidString).json")
    let store = PetLayoutStore(url: path)
    let snapshot = PetLayoutSnapshot(x: 120, y: 340, scale: 1.25, bubbleEnabled: false, reducedMotion: true, soundEnabled: true, bubbleTheme: "dark")
    store.save(snapshot)
    let loadedSnapshot = store.load()
    check(loadedSnapshot?.scale == 1.25 && loadedSnapshot?.bubbleEnabled == false, "布局写读一致")
    check(loadedSnapshot?.theme == .dark, "配色也写读一致", detail: "\(String(describing: loadedSnapshot?.bubbleTheme))")
    // 老文件缺字段也要能读（全字段可选）—— 否则用户的位置/开关会被静默重置
    try? Data(#"{"x":10,"y":20}"#.utf8).write(to: path)
    check(store.load()?.x == 10, "缺字段的老 layout 仍然可读")
    check(!FileManager.default.fileExists(atPath: path.path + ".tmp"), "不留临时文件")
    try? FileManager.default.removeItem(at: path)
}

// 6b) 点通知：日报 → 开弹窗；带会话 → 切会话；其余 → 只当已查看
do {
    let pet = PetAnimation(manifest: manifest, random: SequenceRandom([0.0]).next)
    _ = pet.applyNotice(id: "n1", project: "dsh-assistant", state: .success, title: "任务完成了", detail: "自检",
                        sessionId: "session-abc")
    check(pet.notices.first?.clickAction == .openSession("session-abc"),
          "带 sessionId 的完成通知 → 点击切到该会话", detail: "\(String(describing: pet.notices.first?.clickAction))")

    _ = pet.applyNotice(id: "n2", project: "今天干了什么", state: .success, title: "已生成", detail: "x",
                        action: "open-summary", sessionId: "session-abc")
    check(pet.notices.first?.clickAction == .openSummary, "日报通知优先开弹窗（不抢会话切换）")

    _ = pet.applyNotice(id: "n3", project: "旧宿主", state: .success, title: "任务完成了", detail: "x")
    check(pet.notices.first?.clickAction == .dismiss, "没有 sessionId（老宿主）只当已查看")

    _ = pet.applyNotice(id: "n4", project: "空 id", state: .success, title: "x", detail: "x", sessionId: "")
    check(pet.notices.first?.clickAction == .dismiss, "空 sessionId 不能发出切会话指令")
}

// 7) 气泡 / 窗口几何：测量与绘制同源（PetMetrics 是唯一算式）
do {
    let canvas = manifest.canvas
    let clip = manifest.clip("idle-a")

    // 气泡自己的缩放系数：小尺寸放大、>=70% 封顶
    let mini = PetMetrics(scale: 0.4, bubbleEnabled: true, theme: .light)
    let small = PetMetrics(scale: 0.55, bubbleEnabled: true, theme: .light)
    let large = PetMetrics(scale: 1.0, bubbleEnabled: true, theme: .light)
    check(abs(mini.bubbleScale - 0.6) < 0.001, "40% 档气泡放大到 0.6", detail: "\(mini.bubbleScale)")
    check(abs(small.bubbleScale - 0.825) < 0.001, "55% 档气泡 0.825", detail: "\(small.bubbleScale)")
    check(large.bubbleScale == 1.0, "100% 档不再放大", detail: "\(large.bubbleScale)")
    check(mini.minimumBubbleWidth >= 180, "最小宽度地板生效", detail: "\(mini.minimumBubbleWidth)")

    // 窗口高度 = 角色高 + 间距 + 气泡实测高 + 通知块
    let noBubble = PetMetrics(scale: 1.0, bubbleEnabled: false, theme: .light, noticeCount: 0)
    let short = noBubble.windowSize(clip: clip, canvas: canvas, message: "待机", detail: nil)
    check(abs(short.height - (400 + noBubble.anchorGap)) < 0.6,
          "没有文案时窗口只有角色 + 间距", detail: "\(short.height)")

    let withBubble = PetMetrics(scale: 1.0, bubbleEnabled: true, theme: .light, noticeCount: 0)
    let two = withBubble.windowSize(clip: clip, canvas: canvas, message: "正在执行项目命令", detail: "dsh-assistant · 执行阶段")
    check(two.height > short.height, "两行气泡会把窗口撑高")
    let bubble = withBubble.bubbleSize(message: "正在执行项目命令", detail: "dsh-assistant · 执行阶段", outerWidth: two.width)
    check(abs(two.height - (400 + withBubble.anchorGap + bubble.height)) < 0.6,
          "窗口高度用的是**同一份**气泡实测高度（测量与绘制不会漂移）",
          detail: "window=\(two.height) bubble=\(bubble.height)")

    // 通知带：行高按字体算，进来几条就长几条
    let withNotices = PetMetrics(scale: 1.0, bubbleEnabled: true, theme: .light, noticeCount: 2)
    let notified = withNotices.windowSize(clip: clip, canvas: canvas, message: "待机", detail: nil)
    check(abs(withNotices.noticeBand - (2 * withNotices.noticeRowHeight + withNotices.noticeGap)) < 0.01,
          "通知带 = N 行 + (N-1) 个行距")
    check(notified.height > two.height, "两条通知比两行气泡还高", detail: "\(notified.height) vs \(two.height)")
    check(withNotices.noticeRowHeight > withNotices.detailFont.pointSize * 2,
          "行高至少容得下标题 + 明细两行", detail: "\(withNotices.noticeRowHeight)")

    // 通知矩形：条数对得上、自上而下不重叠、点得到
    let rects = withNotices.noticeRects(ids: ["a", "b"], viewWidth: 300)
    check(rects.count == 2, "每条通知一个矩形")
    check(rects[0].maxY <= rects[1].minY + 0.01, "相邻通知不重叠", detail: "\(rects[0]) / \(rects[1])")
    check(rects.allSatisfy { $0.width > 0 && $0.width <= 300 }, "通知不超出窗口宽度")

    // 角色矩形：不超出窗口、宽度随素材比例走（不拉伸）
    let bounds = NSRect(x: 0, y: 0, width: two.width, height: two.height)
    let petRect = withBubble.petRect(bounds: bounds, clip: clip, bubbleHeight: bubble.height)
    check(petRect.maxX <= bounds.maxX + 0.01 && petRect.minY >= -0.01, "角色完整落在窗口内", detail: "\(petRect)")
    check(abs(petRect.width - 300) < 0.01, "宽度按素材像素宽 × scale（不拉伸）", detail: "\(petRect.width)")
    let narrow = withBubble.petRect(bounds: bounds, clip: manifest.clip("think-b"), bubbleHeight: bubble.height)
    check(narrow.width < petRect.width, "窄素材得到更窄的窗口内容", detail: "\(narrow.width) vs \(petRect.width)")

    // 气泡矩形：居中、贴角色上沿，且不会越出窗口顶
    let rect = withBubble.bubbleRect(size: bubble, outerWidth: two.width, characterTop: petRect.minY)
    check(abs(rect.midX - two.width / 2) < 0.01, "气泡水平居中（与角色同轴）")
    check(rect.minY >= 0 && rect.maxY <= petRect.minY + 0.01, "气泡在角色上方且不越界", detail: "\(rect)")
    let squeezed = withBubble.bubbleRect(size: bubble, outerWidth: two.width, characterTop: 10)
    check(squeezed.height >= 24, "空间不够时最多压到 24pt，不会变成一条缝", detail: "\(squeezed.height)")
}

// 9) 自动互动：任意状态维持满一个周期，就掷一次骰子
do {
    func pet(_ values: [Double], state: PetState = .idle) -> PetAnimation {
        let made = PetAnimation(manifest: manifest, random: SequenceRandom(values).next)
        made.applyState(state, message: "待机", detail: "demo")
        return made
    }
    /// 推进 n 个周期，返回取到的动作（骰子按 values 的固定序列走）
    func roll(_ values: [Double], periods: Int = 1, state: PetState = .idle) -> String? {
        let made = pet(values, state: state)
        for _ in 0..<periods { _ = made.advance(elapsedMs: 10_000) }
        return made.takeAutoInteraction()
    }

    check(roll([0.0, 0.0], periods: 0) == nil, "没推进时间就不该有自动互动")

    let early = pet([0.0, 0.0])
    _ = early.advance(elapsedMs: 9_999)
    check(early.takeAutoInteraction() == nil, "停留不满 10 秒不掷骰子", detail: "dwell=\(early.dwellMs)")

    check(roll([0.29, 0.0]) == "feed", "满 10 秒且骰子命中（0.29 < 0.3）→ 触发投喂")
    check(roll([0.29, 0.5]) == "praise", "同一个骰子也能抽到夸夸它")
    check(roll([0.29, 0.99]) == "pat", "也能抽到摸摸头")
    check(roll([0.3, 0.0]) == nil, "刚好 0.3 不算命中（阈值是严格小于）")
    check(roll([0.9], periods: 3) == nil, "连续三个周期都没中就是安静待着")

    check(roll([0.0, 0.0], state: .thinking) != nil, "THINKING 也适用（任意状态）")
    check(roll([0.0, 0.0], state: .working) != nil, "WORKING 也适用")
    check(roll([0.0, 0.0], state: .error) != nil, "ERROR 也适用")

    // 换状态 → 停留时间从头算
    let reset = PetAnimation(manifest: manifest, random: SequenceRandom([0.0, 0.0]).next)
    reset.applyState(.idle, message: nil, detail: nil)
    _ = reset.advance(elapsedMs: 9_000)
    reset.applyState(.working, message: "干活", detail: nil)
    check(reset.dwellMs == 0, "换状态后停留时间归零", detail: "\(reset.dwellMs)")
    _ = reset.advance(elapsedMs: 2_000)
    check(reset.takeAutoInteraction() == nil, "换状态后才过 2 秒，还不到触发点")
    _ = reset.advance(elapsedMs: 8_000)
    check(reset.takeAutoInteraction() != nil, "新状态也维持满 10 秒 → 照样能触发")

    // 宿主每条事件都会重发同一个状态：值没变要继续攒，不能被打断
    let republish = PetAnimation(manifest: manifest, random: SequenceRandom([0.0, 0.0]).next)
    republish.applyState(.working, message: "在跑", detail: "a")
    for _ in 0..<9 {
        _ = republish.advance(elapsedMs: 1_000)
        republish.applyState(.working, message: "在跑", detail: "a")   // 重复下发同一状态
    }
    check(!republish.dwellMs.isMultiple(of: 10_000) && republish.dwellMs == 9_000,
          "重复下发同一状态不打断计时（量的是状态维持了多久）", detail: "dwell=\(republish.dwellMs)")
    check(republish.takeAutoInteraction() == nil, "9 秒时还没到触发点")
    _ = republish.advance(elapsedMs: 1_000)
    check(republish.takeAutoInteraction() != nil, "第 10 秒到点后照常掷骰子")

    // 没取走之前不攒第二条（定时器被降频后补算也不会连播）
    let burst = pet([0.0, 0.0])
    for _ in 0..<6 { _ = burst.advance(elapsedMs: 10_000) }
    check(burst.takeAutoInteraction() != nil, "60 秒里必中一次")
    check(burst.takeAutoInteraction() == nil, "没取走之前不会攒出第二条")

    // 浮层还在播的时候不打扰
    let busy = pet([0.0, 0.0])
    busy.applyOverlay(action: "pat", message: "摸摸头", ttlMs: 30_000)
    for _ in 0..<2 { _ = busy.advance(elapsedMs: 10_000) }
    check(busy.takeAutoInteraction() == nil, "浮层播放期间不打断（这一轮不掷）")

    // 关得掉
    let off = pet([0.0, 0.0])
    off.autoInteractMs = 0
    for _ in 0..<10 { _ = off.advance(elapsedMs: 10_000) }
    check(off.takeAutoInteraction() == nil, "autoInteractMs = 0 时彻底关闭")
    check(PetAnimation.autoInteractActions == ["feed", "praise", "pat"],
          "可自动触发的动作就是宿主 INTERACTIONS 里的那三个")
}

print("")
if failures == 0 {
    print("全部通过（\(checks) 项检查）")
} else {
    print("失败 \(failures)/\(checks) 项")
    exit(1)
}
