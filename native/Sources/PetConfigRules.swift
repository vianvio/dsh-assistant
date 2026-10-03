import Foundation

/// 配置字段的归一化规则 —— **唯一一份**。
///
/// 为什么单独抽出来：`case "config"` 的分发体以前在 `PetController` 与 `PetHeadless`
/// 里各写一遍（字段白名单 + `min`/`max` 各抄一份），宿主侧 `clampScale()` 还多一道
/// 四舍五入 —— 于是同一个 `scale` 输入两边能跑出不同的值：
///
///     JS  clampScale(0.155)  = 0.16     Swift min(2, max(0.15, 0.155)) = 0.155
///     JS  clampScale("NaN")  = 0.4      Swift 实收 0.15（夹到边界）
///
/// 现在解析与归一化都只在这里发生，两个运行器只负责把结果落到自己的状态上。
/// 与宿主 `src/pet-settings.js` 的 `SETTINGS_FIELDS` 是同一条规则，
/// `npm run test:swift` 里有一组对称用例守着（范围 / 精度 / 非有限值）。
enum PetConfigRules {
    static let scaleMin = 0.15
    static let scaleMax = 2.0
    /// 精度与宿主一致：两位小数（对应 step 0.05）
    static let scaleDecimals = 2

    static let autoInteractMinSeconds = 5
    static let autoInteractMaxSeconds = 300
    static let autoInteractDefaultSeconds = 10

    /// scale：夹到 [0.15, 2] 并四舍五入到两位；**非有限值回默认**（不是夹到边界 ——
    /// `Infinity` 夹到 2 会让宠物突然变最大，宿主那边同样是回默认）。
    static func scale(_ value: Double) -> Double {
        guard value.isFinite else { return PetLayoutSnapshot.defaultScale }
        let clamped = min(scaleMax, max(scaleMin, value))
        let factor = pow(10.0, Double(scaleDecimals))
        return (clamped * factor).rounded() / factor
    }

    /// 自动互动间隔：夹到 [5, 300] 秒并取整；非有限值回默认。
    static func autoInteractSeconds(_ value: Double) -> Int {
        guard value.isFinite else { return autoInteractDefaultSeconds }
        return min(autoInteractMaxSeconds, max(autoInteractMinSeconds, Int(value.rounded())))
    }

    /// 一条 `config` 消息里**被允许**的字段（白名单的唯一定义处）。
    struct Patch {
        var scale: Double?
        var bubbleEnabled: Bool?
        var bubbleTheme: String?
        var reducedMotion: Bool?
        var soundEnabled: Bool?
        var autoInteract: Bool?
        var autoInteractSeconds: Int?

        var isEmpty: Bool {
            scale == nil && bubbleEnabled == nil && bubbleTheme == nil && reducedMotion == nil
                && soundEnabled == nil && autoInteract == nil && autoInteractSeconds == nil
        }
    }

    /// 解析并归一化一条 `config` 消息。白名单外的字段一律忽略（与宿主
    /// `WRITABLE_FIELDS` 对齐：宿主不会发别的，但协议是公开的）。
    static func patch(from message: [String: Any]) -> Patch {
        var patch = Patch()
        if let raw = PetProtocol.doubleValue(message["scale"]) { patch.scale = scale(raw) }
        if let value = message["bubbleEnabled"] as? Bool { patch.bubbleEnabled = value }
        if let raw = PetProtocol.stringValue(message["bubbleTheme"]) { patch.bubbleTheme = raw }
        if let value = message["reducedMotion"] as? Bool { patch.reducedMotion = value }
        if let value = message["soundEnabled"] as? Bool { patch.soundEnabled = value }
        if let value = message["autoInteract"] as? Bool { patch.autoInteract = value }
        if let raw = PetProtocol.doubleValue(message["autoInteractSeconds"]) {
            patch.autoInteractSeconds = autoInteractSeconds(raw)
        }
        return patch
    }
}
