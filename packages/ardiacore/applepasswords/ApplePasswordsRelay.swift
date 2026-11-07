import AppKit
import Darwin

var cleanup: () -> Void = {}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("ardia-apple-passwords: \(message)\n".utf8))
  cleanup()
  exit(1)
}

func shutdown() -> Never {
  cleanup()
  exit(0)
}

func highPipe() -> (read: Int32, write: Int32) {
  var fds: [Int32] = [0, 0]
  guard pipe(&fds) == 0 else { fail("pipe failed") }
  let ends = (read: fcntl(fds[0], F_DUPFD_CLOEXEC, 10), write: fcntl(fds[1], F_DUPFD_CLOEXEC, 10))
  close(fds[0])
  close(fds[1])
  return ends
}

func readExactly(_ fd: Int32, _ count: Int) -> Data? {
  var data = Data(count: count)
  var done = 0
  while done < count {
    let n = data.withUnsafeMutableBytes { read(fd, $0.baseAddress! + done, count - done) }
    if n < 0 && errno == EINTR { continue }
    if n <= 0 { return nil }
    done += n
  }
  return data
}

func writeAll(_ fd: Int32, _ data: Data) {
  let sent = data.withUnsafeBytes { buffer -> Bool in
    var done = 0
    while done < buffer.count {
      let n = write(fd, buffer.baseAddress! + done, buffer.count - done)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return false }
      done += n
    }
    return true
  }
  if !sent { shutdown() }
}

final class DevTools {
  private let input: Int32
  private let output: Int32
  private var buffer = Data()
  private var lastID = 0

  init(input: Int32, output: Int32) {
    self.input = input
    self.output = output
  }

  @discardableResult
  func send(_ method: String, _ params: [String: Any] = [:], session: String? = nil) -> Int {
    lastID += 1
    var message: [String: Any] = ["id": lastID, "method": method, "params": params]
    if let session { message["sessionId"] = session }
    writeAll(input, try! JSONSerialization.data(withJSONObject: message) + [0])
    return lastID
  }

  func next() -> [String: Any]? {
    while true {
      if let end = buffer.firstIndex(of: 0) {
        let message = buffer[buffer.startIndex..<end]
        buffer.removeSubrange(buffer.startIndex...end)
        return (try? JSONSerialization.jsonObject(with: message)) as? [String: Any] ?? [:]
      }
      var bytes = [UInt8](repeating: 0, count: 1 << 16)
      let n = read(output, &bytes, bytes.count)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return nil }
      buffer.append(contentsOf: bytes[0..<n])
    }
  }

  @discardableResult
  func call(_ method: String, _ params: [String: Any] = [:], session: String? = nil) -> [String: Any] {
    let id = send(method, params, session: session)
    while let message = next() {
      guard message["id"] as? Int == id else { continue }
      if let error = message["error"] { fail("\(method): \(error)") }
      let result = message["result"] as? [String: Any] ?? [:]
      if let exception = result["exceptionDetails"] { fail("\(method): \(exception)") }
      return result
    }
    fail("Google Chrome quit during \(method)")
  }
}

guard let chromeApp = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome"),
      let chrome = Bundle(url: chromeApp)?.executablePath
else { fail("Google Chrome isn't installed; Apple's helper only starts under a browser Apple lists") }

let relayExtension = Bundle.main.executableURL!.resolvingSymlinksInPath()
  .deletingLastPathComponent().deletingLastPathComponent()
  .appendingPathComponent("Resources/Extensions/apple-passwords-relay").path
let profile = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-apple-passwords-\(UUID().uuidString)")

let toChrome = highPipe()
let fromChrome = highPipe()
var actions: posix_spawn_file_actions_t?
posix_spawn_file_actions_init(&actions)
posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
posix_spawn_file_actions_adddup2(&actions, toChrome.read, 3)
posix_spawn_file_actions_adddup2(&actions, fromChrome.write, 4)
let arguments = [
  chrome, "--headless", "--user-data-dir=\(profile.path)", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--disable-background-networking",
  "--disable-component-extensions-with-background-pages", "--in-process-gpu",
  "--disable-features=SpareRendererForSitePerProcess,WebUIOmniboxPopup", "--enable-features=NetworkServiceInProcess2",
  "about:blank",
]
var argv = arguments.map { strdup($0) } + [nil]
var chromePid: pid_t = 0
guard posix_spawn(&chromePid, chrome, &actions, nil, &argv, environ) == 0 else { fail("couldn't start Google Chrome") }
close(toChrome.read)
close(fromChrome.write)
cleanup = {
  kill(chromePid, SIGTERM)
  var status: Int32 = 0
  waitpid(chromePid, &status, 0)
  try? FileManager.default.removeItem(at: profile)
}

let devtools = DevTools(input: toChrome.write, output: fromChrome.read)
let extensionID = devtools.call("Extensions.loadUnpacked", ["path": relayExtension])["id"] as? String ?? ""
var worker: String?
for _ in 0..<100 {
  let targets = devtools.call("Target.getTargets")["targetInfos"] as? [[String: Any]] ?? []
  worker = targets.first {
    $0["type"] as? String == "service_worker" && ($0["url"] as? String ?? "").hasPrefix("chrome-extension://\(extensionID)/")
  }?["targetId"] as? String
  if worker != nil { break }
  usleep(50_000)
}
guard let worker else { fail("the relay extension didn't start") }
for target in devtools.call("Target.getTargets")["targetInfos"] as? [[String: Any]] ?? [] where target["type"] as? String == "page" {
  devtools.call("Target.closeTarget", ["targetId": target["targetId"] ?? ""])
}
let session = devtools.call("Target.attachToTarget", ["targetId": worker, "flatten": true])["sessionId"] as? String
devtools.call("Runtime.addBinding", ["name": "relayOut"], session: session)
devtools.call("Runtime.addBinding", ["name": "relayClosed"], session: session)
devtools.call("Runtime.evaluate", ["expression": """
  globalThis.port = chrome.runtime.connectNative("com.apple.passwordmanager");
  port.onMessage.addListener((message) => relayOut(JSON.stringify(message)));
  port.onDisconnect.addListener(() => relayClosed(""));
  """], session: session)

Thread.detachNewThread {
  while let header = readExactly(0, 4) {
    let length = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
    guard let body = readExactly(0, length) else { break }
    let literal = try! JSONSerialization.data(withJSONObject: String(decoding: body, as: UTF8.self), options: .fragmentsAllowed)
    devtools.send("Runtime.evaluate", ["expression": "port.postMessage(JSON.parse(\(String(decoding: literal, as: UTF8.self))))"], session: session)
  }
  shutdown()
}

while let message = devtools.next() {
  guard message["method"] as? String == "Runtime.bindingCalled", let params = message["params"] as? [String: Any] else { continue }
  if params["name"] as? String == "relayClosed" { break }
  let payload = Data((params["payload"] as? String ?? "").utf8)
  var length = UInt32(payload.count)
  writeAll(1, Data(bytes: &length, count: 4) + payload)
}
shutdown()
