import AppKit
import Foundation

/// 启动参数：
///   --headless          只跑协议、不建窗口（自检 / CI 用，走 PetHeadless）
///   --manifest <path>   指定素材清单
///   --layout <path>     指定布局文件
struct LaunchOptions {
    var headless = false
    var manifestPath: String?
    var layoutPath: String?

    static func parse(_ arguments: [String]) -> LaunchOptions {
        var options = LaunchOptions()
        var rest = arguments
        while !rest.isEmpty {
            let argument = rest.removeFirst()
            switch argument {
            case "--headless": options.headless = true
            case "--manifest": options.manifestPath = rest.first; rest = rest.dropFirstOrEmpty()
            case "--layout": options.layoutPath = rest.first; rest = rest.dropFirstOrEmpty()
            default: break
            }
        }
        return options
    }
}

private extension Array {
    /// 取走下一个参数后剩下的（越界时返回空，别崩）。
    func dropFirstOrEmpty() -> [Element] { isEmpty ? [] : Array(dropFirst()) }
}

private func locateManifest(explicit: String?) -> URL? {
    if let explicit, FileManager.default.fileExists(atPath: explicit) {
        return URL(fileURLWithPath: explicit)
    }
    if let env = ProcessInfo.processInfo.environment["DSH_ASSISTANT_ASSET_ROOT"], !env.isEmpty {
        let candidate = URL(fileURLWithPath: env).appendingPathComponent("pet-manifest.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    if let resources = Bundle.main.resourceURL {
        let candidate = resources.appendingPathComponent("pet-manifest.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    // 开发态：从可执行文件往上找 assets/pack
    var directory = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    for _ in 0..<8 {
        let candidate = directory.appendingPathComponent("assets/pack/pet-manifest.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        directory = directory.deletingLastPathComponent()
    }
    return nil
}

/// 逐行读 stdin，把每条消息交给 handler；handler 返回 false 即退出。
private func runProtocolLoop(_ handle: ([String: Any]) -> Bool) -> Never {
    // ready 必须最先发出，且带 v（宿主按 v 校验，缺了整条会被丢掉 —— 握手就永远不成立）
    PetProtocol.write(["kind": "ready"])
    while let line = readLine() {
        guard let message = PetProtocol.decode(line) else {
            // 空行忽略；其它脏输入回一条 error，方便宿主定位
            if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                PetProtocol.write(["kind": "error", "message": "invalid json"])
            }
            continue
        }
        if !handle(message) { exit(0) }
    }
    exit(0)
}

// MARK: - 启动

let options = LaunchOptions.parse(Array(CommandLine.arguments.dropFirst()))

guard let manifestURL = locateManifest(explicit: options.manifestPath) else {
    FileHandle.standardError.write(Data("dsh-assistant: pet-manifest.json not found (pass --manifest or set DSH_ASSISTANT_ASSET_ROOT)\n".utf8))
    exit(2)
}

let loaded: (manifest: PetManifest, root: URL)
do {
    loaded = try PetManifest.load(from: manifestURL)
} catch {
    FileHandle.standardError.write(Data("dsh-assistant: \(error)\n".utf8))
    exit(2)
}

let layoutStore = PetLayoutStore(url: options.layoutPath.map { URL(fileURLWithPath: $0) })

if options.headless {
    let headless = PetHeadless(manifest: loaded.manifest, layout: layoutStore)
    runProtocolLoop { headless.apply($0) }
}

// MARK: - 带窗口的正常运行

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = PetController(manifest: loaded.manifest, root: loaded.root, layout: layoutStore)
controller.start()

// stdin 读取放后台队列，UI 变更回主线程串行执行（动画状态因此只有一个写入者）
DispatchQueue(label: "dsh-assistant.stdin").async {
    while let line = readLine() {
        guard let message = PetProtocol.decode(line) else {
            if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                PetProtocol.write(["kind": "error", "message": "invalid json"])
            }
            continue
        }
        DispatchQueue.main.async { controller.apply(message) }
    }
    // stdin EOF = 宿主没了（DSH 强退也会走到这里），自己收摊，别留孤儿面板
    DispatchQueue.main.async {
        controller.stop(reason: "stdin-eof")
        NSApp.terminate(nil)
    }
}

app.run()
