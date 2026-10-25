// Wi-Diagnostics macOS scanner helper.
// Streams CoreWLAN scan results and link telemetry as JSON lines on stdout.
//
//   wiscan stream [interval]   continuous scans + 1 Hz link telemetry
//   wiscan once                single scan, then exit
//   wiscan authorize           ask for Location permission (unredacts SSID/BSSID)
//   wiscan status              print Location authorization status

import CoreLocation
import CoreWLAN
import Foundation

struct NetworkOut: Encodable {
    var ssid: String?
    var bssid: String?
    var rssi: Int
    var noise: Int
    var channel: Int
    var band: String?
    var width: Int?
    var beacon: Int
    var security: [String]
    var phy: [String]
    var country: String?
}

struct ScanOut: Encodable {
    let type = "scan"
    var t: Double
    var cached: Bool
    var durationMs: Int
    var networks: [NetworkOut]
}

struct LinkOut: Encodable {
    let type = "link"
    var t: Double
    var iface: String?
    var powered: Bool
    var associated: Bool
    var ssid: String?
    var bssid: String?
    var rssi: Int?
    var noise: Int?
    var txRate: Double?
    var channel: Int?
    var band: String?
    var width: Int?
    var phy: String?
    var security: String?
    var txPower: Int?
    var mac: String?
    var country: String?
}

struct StatusOut: Encodable {
    var type: String
    var auth: String
    var iface: String?
    var message: String?
}

// Output goes to stdout, or to a Unix socket when launched through LaunchServices
// (`open WiScan.app --args stream 2 --socket <path>`), which is what lets a
// Location permission granted to this app actually apply.
var outFd: Int32 = STDOUT_FILENO
let outLock = NSLock()
signal(SIGPIPE, SIG_IGN)

func connectSocket(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        ptr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
            _ = path.withCString { strncpy(dst, $0, capacity - 1) }
        }
    }
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
        }
    }
    if !ok {
        close(fd)
        return nil
    }
    return fd
}

func emit<T: Encodable>(_ value: T) {
    guard var data = try? JSONEncoder().encode(value) else { return }
    data.append(0x0A)
    outLock.lock()
    defer { outLock.unlock() }
    let written = data.withUnsafeBytes { write(outFd, $0.baseAddress, data.count) }
    if written < 0 { exit(0) } // reader went away
}

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

func bandName(_ channel: CWChannel?) -> String? {
    guard let c = channel else { return nil }
    switch c.channelBand {
    case .band2GHz: return "2.4"
    case .band5GHz: return "5"
    case .band6GHz: return "6"
    default: return nil
    }
}

func widthMHz(_ channel: CWChannel?) -> Int? {
    guard let c = channel else { return nil }
    switch c.channelWidth {
    case .width20MHz: return 20
    case .width40MHz: return 40
    case .width80MHz: return 80
    case .width160MHz: return 160
    default: return nil
    }
}

let phyNames: [Int: String] = [1: "a", 2: "b", 3: "g", 4: "n", 5: "ac", 6: "ax", 7: "be"]

func securityTokens(_ s: CWSecurity) -> [String] {
    switch s {
    case .none: return ["open"]
    case .WEP, .dynamicWEP: return ["wep"]
    case .wpaPersonal: return ["wpa"]
    case .wpaPersonalMixed: return ["wpa2"] // CoreWLAN reports this for plain WPA2 too
    case .wpa2Personal, .personal: return ["wpa2"]
    case .wpa3Personal: return ["wpa3"]
    case .wpa3Transition: return ["wpa2", "wpa3t"]
    case .wpaEnterprise, .wpaEnterpriseMixed: return ["wpa"]
    case .wpa2Enterprise, .enterprise: return ["wpa2e"]
    case .wpa3Enterprise: return ["wpa3e"]
    case .OWE: return ["owe"]
    case .oweTransition: return ["owe", "open"]
    default: return []
    }
}

let allSecurity: [CWSecurity] = [
    .none, .WEP, .wpaPersonal, .wpaPersonalMixed, .wpa2Personal, .personal, .dynamicWEP,
    .wpaEnterprise, .wpaEnterpriseMixed, .wpa2Enterprise, .enterprise, .wpa3Personal,
    .wpa3Enterprise, .wpa3Transition, .OWE, .oweTransition,
]

func describe(_ n: CWNetwork) -> NetworkOut {
    var sec = Set<String>()
    for s in allSecurity where n.supportsSecurity(s) {
        securityTokens(s).forEach { sec.insert($0) }
    }
    var phy: [String] = []
    for raw in 1...7 {
        if let mode = CWPHYMode(rawValue: raw), n.supportsPHYMode(mode), let name = phyNames[raw] {
            phy.append(name)
        }
    }
    return NetworkOut(
        ssid: n.ssid,
        bssid: n.bssid,
        rssi: n.rssiValue,
        noise: n.noiseMeasurement,
        channel: n.wlanChannel?.channelNumber ?? 0,
        band: bandName(n.wlanChannel),
        width: widthMHz(n.wlanChannel),
        beacon: n.beaconInterval,
        security: Array(sec).sorted(),
        phy: phy,
        country: n.countryCode
    )
}

func authName(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorizedAlways: return "authorized"
    default: return "authorized"
    }
}

func currentAuth() -> String { authName(CLLocationManager().authorizationStatus) }

guard let iface = CWWiFiClient.shared().interface() else {
    emit(StatusOut(type: "error", auth: currentAuth(), iface: nil, message: "no Wi-Fi interface"))
    exit(2)
}

func linkSnapshot() -> LinkOut {
    let rssi = iface.rssiValue()
    let associated = rssi != 0 && iface.wlanChannel() != nil
    let phyRaw = iface.activePHYMode().rawValue
    return LinkOut(
        t: now(),
        iface: iface.interfaceName,
        powered: iface.powerOn(),
        associated: associated,
        ssid: iface.ssid(),
        bssid: iface.bssid(),
        rssi: associated ? rssi : nil,
        noise: associated ? iface.noiseMeasurement() : nil,
        txRate: associated ? iface.transmitRate() : nil,
        channel: iface.wlanChannel()?.channelNumber,
        band: bandName(iface.wlanChannel()),
        width: widthMHz(iface.wlanChannel()),
        phy: phyNames[phyRaw],
        security: associated ? securityTokens(iface.security()).last : nil,
        txPower: associated ? iface.transmitPower() : nil,
        mac: iface.hardwareAddress(),
        country: iface.countryCode()
    )
}

func scanOnce() -> ScanOut? {
    let start = Date()
    do {
        let networks = try iface.scanForNetworks(withName: nil, includeHidden: true)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        return ScanOut(t: now(), cached: false, durationMs: ms, networks: networks.map(describe))
    } catch {
        emit(StatusOut(type: "error", auth: currentAuth(), iface: iface.interfaceName, message: "\(error)"))
        return nil
    }
}

final class AuthDelegate: NSObject, CLLocationManagerDelegate {
    let ifaceName: String?
    init(ifaceName: String?) { self.ifaceName = ifaceName }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status != .notDetermined {
            emit(StatusOut(type: "auth", auth: authName(status), iface: ifaceName, message: nil))
            exit(status == .denied || status == .restricted ? 1 : 0)
        }
    }
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "stream"

switch mode {
case "status":
    emit(StatusOut(type: "auth", auth: currentAuth(), iface: iface.interfaceName, message: nil))

case "authorize":
    let manager = CLLocationManager()
    let delegate = AuthDelegate(ifaceName: iface.interfaceName)
    manager.delegate = delegate
    if manager.authorizationStatus == .notDetermined {
        manager.requestWhenInUseAuthorization()
        // Some macOS versions only surface the prompt once location is actually requested.
        manager.startUpdatingLocation()
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
            emit(StatusOut(type: "auth", auth: currentAuth(), iface: iface.interfaceName, message: "timeout"))
            exit(3)
        }
        RunLoop.main.run()
    } else {
        emit(StatusOut(type: "auth", auth: currentAuth(), iface: iface.interfaceName, message: nil))
    }

case "once":
    emit(linkSnapshot())
    if let scan = scanOnce() { emit(scan) }

default:
    let interval = args.count > 2 ? (Double(args[2]) ?? 2) : 2
    var viaSocket = false
    if let i = args.firstIndex(of: "--socket"), i + 1 < args.count {
        guard let fd = connectSocket(args[i + 1]) else { exit(4) }
        outFd = fd
        viaSocket = true
    }
    emit(StatusOut(type: "hello", auth: currentAuth(), iface: iface.interfaceName, message: nil))
    emit(linkSnapshot())

    // Instant first paint from the OS scan cache; the engine treats it as provisional.
    if let cached = iface.cachedScanResults(), !cached.isEmpty {
        emit(ScanOut(t: now(), cached: true, durationMs: 0, networks: cached.map(describe)))
    }

    Thread.detachNewThread {
        while true {
            // When scans come too close together (this or another process), macOS
            // throttles and answers from its cache in ~0.1 s. Without SSID/BSSID the
            // cache cannot be deduplicated, so those answers are skipped.
            guard let scan = scanOnce(), scan.durationMs >= 1500 else {
                Thread.sleep(forTimeInterval: max(interval, 4))
                continue
            }
            emit(scan)
            Thread.sleep(forTimeInterval: interval)
        }
    }

    while true {
        Thread.sleep(forTimeInterval: 1)
        if !viaSocket && getppid() == 1 { exit(0) } // parent went away
        emit(linkSnapshot())
    }
}
