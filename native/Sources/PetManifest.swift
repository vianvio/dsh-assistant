import Foundation

/// 宠物精灵清单（v4，由 scripts/build_pack.py 生成）。
///
/// ```json
/// {
///   "formatVersion": 4,
///   "canvas": { "width": 549, "height": 400 },   // 参考尺寸（最宽素材 × 统一高度）
///   "bubbleBand": 84,
///   "clips": { "idle-cute": { "file": "idle/idle-cute.webp",
///                             "width": 300, "height": 400, "top": 0 } },
///   "states": { "IDLE": ["idle-cute", "daily-coffee", ...] },
///   "actions": { "pat": ["work-pat", ...] }
/// }
/// ```
///
/// 设计：**素材是静图就保持静态**（不烘帧、不做假动画）。
///   例外：由百炼生成的微动作序列帧会在 clip 上带 `dir/prefix/count/frameMs`，
///   这类 clip 才逐帧播放；其余 clip 只有一张图，画面不动。
///   · 所有图统一高度（`height` 都一样），所以切状态时角色大小不会跳；
///   · 宽度按原图比例（`width` 各不相同），原生端据此建窗 —— 窗口紧贴角色，
///     不会留一大片透明区域白吃鼠标点击；
///   · `top` 是内容顶边，气泡贴着它放（裁剪过的图通常为 0）。
struct PetManifest {
    struct Clip {
        /// 首帧/静图文件（相对 pack 根目录）。
        let file: String
        /// 图片像素尺寸（所有 clip 高度一致，宽度按原图比例）。
        let width: CGFloat
        let height: CGFloat
        /// 内容顶边（气泡贴着它放；裁剪过的图通常为 0）。
        let top: CGFloat

        /// 可选：序列帧（百炼生成的微动作）。为空 = 静图，只显示第一帧。
        let frames: [String]
        let frameMs: Int
        let loop: Bool

        var isAnimated: Bool { frames.count > 1 }
    }

    let canvas: NSSize
    /// 顶部留白高度：气泡只能画在这条带子里（角色占下方）。
    let bubbleBand: CGFloat
    let clips: [String: Clip]
    let states: [String: [String]]
    let actions: [String: [String]]

    func clip(_ name: String) -> Clip? { clips[name] }

    /// 某状态可用的素材；该状态没登记（或登记的名字都不存在）时退回 IDLE。
    func variants(forState state: PetState) -> [String] {
        let list = states[state.rawValue] ?? states[PetState.fallback.rawValue] ?? []
        return list.isEmpty ? Array(clips.keys.sorted()) : list
    }

    /// 素材表里登记过的状态（诊断/自检用）。
    var declaredStates: [String] { states.keys.sorted() }

    func variants(forAction action: String) -> [String] {
        actions[action] ?? []
    }

    static func load(from url: URL) throws -> (manifest: PetManifest, root: URL) {
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PetManifestError.malformed("manifest root is not an object")
        }
        guard (json["formatVersion"] as? Int) == 4 else {
            throw PetManifestError.malformed("unsupported formatVersion (need 4；先 npm run build:pack)")
        }

        var clips: [String: Clip] = [:]
        if let raw = json["clips"] as? [String: Any] {
            for (name, value) in raw {
                guard let entry = value as? [String: Any], let file = entry["file"] as? String else { continue }
                // 序列帧字段是可选的：没有就是静图（素材本来就是静图，不做假动画）
                var frames: [String] = []
                if let dir = entry["dir"] as? String,
                   let prefix = entry["prefix"] as? String,
                   let count = (entry["count"] as? NSNumber)?.intValue, count > 1 {
                    frames = (1...min(count, 512)).map {
                        String(format: "%@/%@_%03d.webp", dir, prefix, $0)
                    }
                }
                clips[name] = Clip(
                    file: file,
                    width: CGFloat((entry["width"] as? NSNumber)?.doubleValue ?? 0),
                    height: CGFloat((entry["height"] as? NSNumber)?.doubleValue ?? 0),
                    top: CGFloat((entry["top"] as? NSNumber)?.doubleValue ?? 0),
                    frames: frames,
                    frameMs: max(16, (entry["frameMs"] as? NSNumber)?.intValue ?? 90),
                    loop: (entry["loop"] as? Bool) ?? true
                )
            }
        }
        guard !clips.isEmpty else { throw PetManifestError.malformed("manifest has no clips") }

        let states = variantTable(json["states"], clips: clips)
        guard !states.isEmpty else { throw PetManifestError.malformed("manifest has no states") }
        let actions = variantTable(json["actions"], clips: clips)

        let canvasJSON = json["canvas"] as? [String: Any]
        let width = CGFloat((canvasJSON?["width"] as? NSNumber)?.doubleValue ?? 448)
        let height = CGFloat((canvasJSON?["height"] as? NSNumber)?.doubleValue ?? 400)

        return (
            PetManifest(
                canvas: NSSize(width: max(120, width), height: max(160, height)),
                bubbleBand: CGFloat((json["bubbleBand"] as? NSNumber)?.doubleValue ?? 84),
                clips: clips,
                states: states,
                actions: actions
            ),
            url.deletingLastPathComponent()
        )
    }
}

/// 把 `{ "IDLE": ["a","b"] }` 这类"状态/动作 → 素材名"的表解析出来，
/// 顺手丢掉指向不存在素材的名字（素材表与素材不同步时不至于画空白）。
private func variantTable(_ raw: Any?, clips: [String: PetManifest.Clip]) -> [String: [String]] {
    guard let raw = raw as? [String: Any] else { return [:] }
    var table: [String: [String]] = [:]
    for (key, value) in raw {
        guard let list = value as? [String] else { continue }
        let existing = list.filter { clips[$0] != nil }
        if !existing.isEmpty { table[key] = existing }
    }
    return table
}

enum PetManifestError: Error, CustomStringConvertible {
    case malformed(String)

    var description: String {
        switch self {
        case .malformed(let detail): return "invalid pet manifest: \(detail)"
        }
    }
}
