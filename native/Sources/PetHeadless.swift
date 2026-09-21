import Foundation

/// headless 运行器：**不建窗口**，但走与 PetController 同一套协议解析与同一套动画内核。
///
/// 为什么要有它：自检（`npm run verify`）与探针靠它确认"宿主发的消息真的被理解了"。
/// 早先 headless 只认 ping/shutdown，于是自检绿灯也证明不了任何真实消息能被处理 ——
/// 现在它把每个 kind 都过一遍，消息名对不上会立刻在自检里暴露。
final class PetHeadless {
    private let animation: PetAnimation
    private let channel: PetOutbound
    private var scale: Double
    private var bubbleEnabled: Bool
    /// 收到过哪些 kind（供 --dump-kinds 排查协议漂移）
    private(set) var seenKinds: [String] = []

    init(manifest: PetManifest, layout: PetLayoutStore, channel: PetOutbound = StdoutChannel()) {
        self.animation = PetAnimation(manifest: manifest)
        self.channel = channel
        let saved = layout.load()
        self.scale = saved?.scale ?? PetLayoutSnapshot.defaultScale
        self.bubbleEnabled = saved?.bubbleEnabled ?? true
    }

    /// 处理一条已解析的消息；返回 false 表示该退出了。
    func apply(_ message: [String: Any]) -> Bool {
        let kind = PetProtocol.stringValue(message["kind"]) ?? ""
        seenKinds.append(kind)
        switch kind {
        case "hello":
            break
        case "state":
            animation.applyState(stateOf(message) ?? .idle,
                                 message: PetProtocol.stringValue(message["message"]),
                                 detail: PetProtocol.stringValue(message["detail"]))
        case "pulse":
            animation.applyPulse(
                state: stateOf(message) ?? .success,
                ttlMs: PetProtocol.intValue(message["ttlMs"]) ?? 2000,
                message: PetProtocol.stringValue(message["message"]),
                resumeState: PetProtocol.stringValue(message["resumeState"]).flatMap(PetState.init(rawValue:))
            )
        case "overlay":
            animation.applyOverlay(
                clip: PetProtocol.stringValue(message["clip"]),
                action: PetProtocol.stringValue(message["action"]),
                message: PetProtocol.stringValue(message["message"]),
                ttlMs: PetProtocol.intValue(message["ttlMs"]) ?? 2000
            )
        case "notice":
            animation.applyNotice(
                id: PetProtocol.stringValue(message["id"]) ?? "",
                project: PetProtocol.stringValue(message["project"]) ?? "会话",
                state: stateOf(message) ?? .success,
                title: PetProtocol.stringValue(message["title"]) ?? "任务完成了",
                detail: PetProtocol.stringValue(message["detail"]) ?? "",
                action: PetProtocol.stringValue(message["action"]),
                sessionId: PetProtocol.stringValue(message["sessionId"])
            )
        case "notice-clear":
            animation.clearNotices(
                id: PetProtocol.stringValue(message["id"]),
                project: PetProtocol.stringValue(message["project"])
            )
        case "config":
            if let value = PetProtocol.doubleValue(message["scale"]) { scale = min(2.0, max(0.15, value)) }
            if let value = message["bubbleEnabled"] as? Bool { bubbleEnabled = value }
        case "summary":
            // 与 PetController 同一条回执：宿主/探针据此确认正文真的到了
            channel.send(["kind": "interaction", "source": "host", "action": "summary-stored",
                          "chars": (PetProtocol.stringValue(message["markdown"]) ?? "").count])
        case "command":
            break
        case "ping":
            channel.send(["kind": "pong"])
        case "shutdown":
            channel.send(["kind": "closed", "reason": "host"])
            return false
        default:
            channel.send(["kind": "error", "message": "unknown kind: \(kind)"])
        }
        return true
    }

    /// 自检用的自报（确认配置真的被应用了）。
    var snapshot: [String: Any] {
        [
            "state": animation.state.rawValue,
            "clip": animation.clipName,
            "scale": scale,
            "bubbleEnabled": bubbleEnabled,
            "bubble": animation.bubbleMessage ?? "",
            "notices": animation.notices.count,
        ]
    }

    private func stateOf(_ message: [String: Any]) -> PetState? {
        PetProtocol.stringValue(message["state"]).flatMap(PetState.init(rawValue:))
    }
}
