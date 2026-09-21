import AppKit

/// 分层懒加载的帧仓库。
///
/// 与 dafeiyu 的差异（这是本项目刻意的加固点）：它启动时会把 manifest 里所有
/// clip 的帧都用 `Data(contentsOf:)` 读进内存（实测 45MB），而这里：
///   · 只按“当前播放的 clip”读盘，读过的解成 NSImage 放进 NSCache；
///   · 磁盘字节缓存上限很小（默认 24 张），内存里不会出现整包素材；
///   · 预读下一帧（一次 1 张），避免循环边界卡顿。
final class FrameStore {
    private let root: URL
    private let cache = NSCache<NSString, NSImage>()

    init(root: URL, baseSize: CGFloat, cacheLimitMB: Int = 32) {
        self.root = root
        // 成本上限按"一张参考尺寸的 RGBA"估算即可：真正逐张算成本太贵，
        // 而 NSS 张数上限才是主要约束。原来用画布宽度算会低估（素材按显示尺寸烘焙，
        // 最宽的那张比画布还宽），所以按"最宽的一档"留足余量。
        let side = max(64, Int(baseSize))
        cache.totalCostLimit = max(side * side * 4 * 2, cacheLimitMB * 1024 * 1024)
        cache.countLimit = 64
    }

    func image(for path: String) -> NSImage? {
        let key = path as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let url = root.appendingPathComponent(path)
        guard let image = NSImage(contentsOf: url) else {
            // 读不出来只影响这一帧；但静默失败会让"素材缺失"变成"宠物不见了"，
            // 排查时没有任何线索，所以至少留一行 stderr。
            FileHandle.standardError.write(Data("dsh-assistant: missing frame \(path)\n".utf8))
            return nil
        }
        cache.setObject(image, forKey: key, cost: Self.cost(of: image))
        return image
    }

    /// 解出的位图字节数（按像素算，不按点）。
    private static func cost(of image: NSImage) -> Int {
        let pixels = image.representations.compactMap { $0 as? NSBitmapImageRep }
            .map { $0.pixelsWide * $0.pixelsHigh * 4 }
            .max()
        return pixels ?? Int(image.size.width * image.size.height * 4)
    }

    /// 预读（失败静默：下一帧读不到会在真正绘制时再试）。
    func prefetch(_ path: String) {
        _ = image(for: path)
    }

    func purge() {
        cache.removeAllObjects()
    }
}
