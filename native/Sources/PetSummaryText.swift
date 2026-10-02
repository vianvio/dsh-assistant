import Foundation

/// 「今天干了什么」结果页的**纯文本**规则。
///
/// 单独一个文件的原因：提示行的规范化（空 = 不显示、只去首尾空白）会被
/// 控制器（PetController）、无头模式（PetHeadless）和窗口三处用到，
/// 而窗口那半边要 AppKit、进不了纯逻辑测试目标（scripts/test-swift.sh 只编
/// 「不依赖窗口」的那几件）。放这里，三处引同一份，且能被断言覆盖。
enum PetSummaryText {
    /// 结果页底部提示的规范化。
    ///
    /// 空白字符串一律算"没有提示"（宿主按开关状态决定发不发；发了空串也不该占一行）。
    /// 内容不做裁剪 —— 那句话是要给用户看的，长度由宿主侧把关。
    static func hint(_ raw: String?) -> String {
        (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
