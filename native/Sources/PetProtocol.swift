import Foundation

/// 宿主 ↔ helper 的**行协议**（v1）：一行一条 JSON。
///
/// 这里只放"怎么编解码一行"和"怎么安全地取字段"，不放业务分发 ——
/// headless 模式与 PetController 共用同一份，两边才不会各自漂移
/// （历史上 headless 只认 ping/shutdown，等于自检根本盖不到真实协议）。
enum PetProtocol {
    static let version = 1

    /// 解析一行输入；不合法返回 nil（调用方只需判空）。
    static func decode(_ line: String) -> [String: Any]? {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard intValue(object["v"]) == version else { return nil }
        guard object["kind"] is String else { return nil }
        return object
    }

    /// 编码一行输出（自动补 v / ts，与宿主 protocol.js 的校验对齐）。
    static func encode(_ payload: [String: Any]) -> Data {
        var message = payload
        message["v"] = version
        if message["ts"] == nil {
            message["ts"] = Int(Date().timeIntervalSince1970 * 1000)
        }
        let data = (try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]))
            ?? Data("{\"v\":1,\"kind\":\"error\",\"message\":\"encode failed\"}".utf8)
        return data
    }

    /// 写一行到 stdout。加锁：stdin 线程（协议回执）与主线程（状态变更）都会写，
    /// 不加锁两行 JSON 会交错成一行废数据。
    static func write(_ payload: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(encode(payload))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private static let lock = NSLock()

    /// 取整数：JSON 里的数字是 NSNumber，字符串形式的数字也认。
    static func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let text = value as? String { return Int(text) }
        return nil
    }

    static func doubleValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text) }
        return nil
    }

    /// 取字符串字段：非空才返回，省掉调用处的 `as? String` 判空。
    static func stringValue(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return text
    }
}

/// 输出通道：可直接换成内存缓冲，便于自检读取 helper 到底发了什么。
protocol PetOutbound: AnyObject {
    func send(_ payload: [String: Any])
}

/// 标准输出（生产路径）。
final class StdoutChannel: PetOutbound {
    func send(_ payload: [String: Any]) {
        PetProtocol.write(payload)
    }
}
