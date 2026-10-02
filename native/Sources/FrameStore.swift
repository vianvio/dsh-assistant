import AppKit

/// 分层懒加载的帧仓库。
///
/// 与 dafeiyu 的差异（这是本项目刻意的加固点）：它启动时会把 manifest 里所有
/// clip 的帧都用 `Data(contentsOf:)` 读进内存（实测 45MB），而这里：
///   · 只按“当前播放的 clip”读盘，读过的解成位图放进 NSCache；
///   · 磁盘字节缓存上限很小（默认 24 张），内存里不会出现整包素材；
///   · 预读下一帧（一次 1 张），避免循环边界卡顿。
///
/// **为什么缓存的是 `CGImage` 而不是 `NSImage`**：
/// `NSImage(contentsOf:)` 是"懒"的 —— 它只记住文件位置，像素等到真正绘制时才解。
/// 于是每一帧的 blit 都重新走一遍 ImageIO 解码（sample 里能看到 `GetCoeffsFast` /
/// `GetLargeValue` 在稳态绘制中反复出现），而解出来的数据立刻又被丢掉。
/// 这里改成：解码一次 → 复制进我们自己的 `CGBitmapContext` → 缓存那张位图的 `CGImage`。
/// 之后绘制只是一次内存位图 blit，不再碰磁盘、也不再碰解码器。
final class FrameStore {
    private let root: URL
    private let cache = NSCache<NSString, CGImage>()

    init(root: URL, baseSize: CGFloat, cacheLimitMB: Int = 32) {
        self.root = root
        // 成本上限按"一张参考尺寸的 RGBA"估算即可：真正逐张算成本太贵，
        // 而 NSS 张数上限才是主要约束。原来用画布宽度算会低估（素材按显示尺寸烘焙，
        // 最宽的那张比画布还宽），所以按"最宽的一档"留足余量。
        let side = max(64, Int(baseSize))
        cache.totalCostLimit = max(side * side * 4 * 2, cacheLimitMB * 1024 * 1024)
        cache.countLimit = 64
    }

    /// 取一帧的解码后位图（已脱离文件，绘制时不再解码）。
    func cgImage(for path: String) -> CGImage? {
        let key = path as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let url = root.appendingPathComponent(path)
        guard let image = Self.decode(url) else {
            // 读不出来只影响这一帧；但静默失败会让"素材缺失"变成"宠物不见了"，
            // 排查时没有任何线索，所以至少留一行 stderr。
            FileHandle.standardError.write(Data("dsh-assistant: missing frame \(path)\n".utf8))
            return nil
        }
        cache.setObject(image, forKey: key, cost: image.bytesPerRow * image.height)
        return image
    }

    /// 解码并**落成自有位图**。
    ///
    /// 直接把 `CGImageSourceCreateImageAtIndex` 的结果拿来用是不够的：那个 CGImage
    /// 背后还挂着原始数据源，CoreGraphics 可能在每次绘制时重新解一遍。这里显式地把它
    /// 画进一块自己的 `CGBitmapContext`，`makeImage()` 出来的才是纯内存位图。
    private static func decode(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        // shouldCacheImmediately：让解码发生在**这一步**，而不是拖到第一次绘制
        guard let decoded = CGImageSourceCreateImageAtIndex(
            source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        ) else { return nil }
        // 素材是 8-bit sRGB 的 WebP。目标位图也用 sRGB，交给 CoreAnimation 上传时
        // 只剩一次可缓存的显示色彩空间映射，而不是每帧逐像素做 CMS 转换
        //（sample 里的 RGBAf16_sample_RGBAf_inner + vImageConverterConvert 就是它）。
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? decoded.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: decoded.width,
            height: decoded.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return decoded }
        context.draw(decoded, in: CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
        return context.makeImage() ?? decoded
    }

    /// 预读（失败静默：下一帧读不到会在真正绘制时再试）。
    func prefetch(_ path: String) {
        _ = cgImage(for: path)
    }

    func purge() {
        cache.removeAllObjects()
    }
}
