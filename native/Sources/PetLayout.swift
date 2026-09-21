import Foundation

/// 窗口位置/偏好的持久化。
///
/// 与 dafeiyu 的差别：DSH_HOME 是首选位置（多 profile 各自独立），
/// 但同时在 Application Support 里留一份，避免用户改 DSH_HOME 后窗口跑到屏幕外。
///
/// 解码**全字段可选**：老版本写下的文件缺字段是常态（`bubbleTheme` 就是后加的，
/// `updatedAt` 则从来没被读过）。必需字段一旦对不上，整份 layout 就解不出来，
/// 用户的位移/大小/开关会被静默重置回默认值。
struct PetLayoutSnapshot: Codable {
    /// 默认出镜尺寸：与宿主 `defaults.scale` 一致（40%）。
    ///
    /// **两边必须一致**：宿主只在"用户显式设过 scale"时才下发它，没设过就由这里兜底，
    /// 否则全新安装会以 100% 出镜（比预期大一倍多）。
    static let defaultScale: Double = 0.4

    var x: Double?
    var y: Double?
    var scale: Double?
    var bubbleEnabled: Bool?
    var reducedMotion: Bool?
    var soundEnabled: Bool?
    /// 气泡配色：light / dark（缺省 light，老文件解不出来时用默认值）
    var bubbleTheme: String?

    var theme: BubbleTheme? { bubbleTheme.flatMap(BubbleTheme.init(rawValue:)) }

    init(x: Double? = nil, y: Double? = nil, scale: Double? = nil, bubbleEnabled: Bool? = nil,
         reducedMotion: Bool? = nil, soundEnabled: Bool? = nil, bubbleTheme: String? = nil) {
        self.x = x
        self.y = y
        self.scale = scale
        self.bubbleEnabled = bubbleEnabled
        self.reducedMotion = reducedMotion
        self.soundEnabled = soundEnabled
        self.bubbleTheme = bubbleTheme
    }
}

final class PetLayoutStore {
    private let url: URL

    init(url: URL? = nil) {
        if let url {
            self.url = url
            return
        }
        let env = ProcessInfo.processInfo.environment
        if let override = env["DSH_ASSISTANT_LAYOUT_PATH"], !override.isEmpty {
            self.url = URL(fileURLWithPath: override)
            return
        }
        if let home = env["DSH_HOME"], !home.isEmpty {
            self.url = URL(fileURLWithPath: home).appendingPathComponent("dsh-assistant/layout.json")
            return
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        self.url = support.appendingPathComponent("dsh-assistant/layout.json")
    }

    func load() -> PetLayoutSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PetLayoutSnapshot.self, from: data)
    }

    /// 原子替换：写同目录临时文件 → `replaceItemAt` 换上新内容。
    ///
    /// 不能用"先 removeItem 再 moveItem"：两步之间文件**不存在**，
    /// 这一瞬间崩溃/掉电就丢了用户的全部偏好（而注释还写着"原子写入"）。
    func save(_ snapshot: PetLayoutSnapshot) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(snapshot)
            let temporary = url.appendingPathExtension("tmp")
            try data.write(to: temporary, options: .atomic)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: url)
            }
        } catch {
            // 写不进去只影响下次启动的位置，不该影响本次运行
            FileHandle.standardError.write(Data("dsh-assistant: failed to persist layout: \(error)\n".utf8))
        }
    }
}
