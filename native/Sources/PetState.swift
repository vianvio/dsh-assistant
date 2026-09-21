import Foundation

/// 七个**耐久状态**（与宿主 `src/protocol.js` 的 PetState、素材包的 states 表一一对应）。
///
/// 为什么不用裸字符串：状态名在动画内核、控制器、素材表、可访问性文案里到处传，
/// 拼错一个字母只会静默退化成 IDLE 素材（气泡却还显示那个错名字）。
/// 枚举让这类错误在编译期就暴露。
enum PetState: String, CaseIterable {
    case idle = "IDLE"
    case thinking = "THINKING"
    case working = "WORKING"
    case waiting = "WAITING"
    case success = "SUCCESS"
    case error = "ERROR"
    case disconnected = "DISCONNECTED"

    /// 素材表里读不到这个状态时退回 IDLE 底图。
    static let fallback: PetState = .idle

    /// 中文名（可访问性文案用）。
    var label: String {
        switch self {
        case .idle: return "待机"
        case .thinking: return "思考中"
        case .working: return "干活中"
        case .waiting: return "等你确认"
        case .success: return "完成了"
        case .error: return "出错了"
        case .disconnected: return "失联"
        }
    }
}
