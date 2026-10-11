import Foundation

/// One opt-in contribution: your feedback on a result plus the masked text it was about.
public struct ContributionPayload: Codable, Sendable, Equatable, Identifiable {
    public struct System: Codable, Sendable, Equatable {
        public var riskLevel: String
        public var riskScore: Int
        public var category: String?
    }
    public var id: UUID
    public var historyEntryID: UUID
    public var installationId: String
    public var text: String
    public var verdict: String
    public var system: System
    public var appVersion: String
    public var createdAt: Date

    /// The JSON body the service accepts (no local IDs or dates).
    public func requestBody() throws -> Data {
        struct Body: Encodable { let installationId: String; let text: String; let verdict: String; let system: System; let appVersion: String }
        return try JSONEncoder().encode(Body(installationId: installationId, text: text, verdict: verdict, system: system, appVersion: appVersion))
    }
}

/// Opt-in sharing of feedback to improve detection ("shared learning").
///
/// Off by default. When on, giving feedback on a History entry queues the entry's already-masked
/// text with your verdict; queued items are sent to the ScamShield service you are connected to
/// and removed once it accepts them. Nothing is queued when the scanned text wasn't saved, and
/// screenshots are never involved. The service stores contributions in quarantine — they never
/// change the detection model by themselves.
@MainActor
@Observable
public final class ContributionOutbox {
    public enum SendResult: Sendable, Equatable { case accepted, notAccepted(Int), failed }

    public private(set) var pending: [ContributionPayload] = []
    public private(set) var lastStatus: String?
    public var isEnabled: Bool {
        didSet {
            defaults.set(isEnabled, forKey: Keys.enabled)
            if !isEnabled { clear() }
        }
    }

    @ObservationIgnored public let fileURL: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let appVersion: String
    @ObservationIgnored private var sending = false

    public static let maxPending = 200
    enum Keys { static let enabled = "shareFeedbackForLearning", installation = "contributionInstallationID" }

    public init(directory: URL = HistoryStore.defaultDirectory, defaults: UserDefaults = .standard, appVersion: String = "1.0.0") {
        fileURL = directory.appendingPathComponent("contributions-outbox.json")
        self.defaults = defaults
        self.appVersion = appVersion.range(of: #"^[\w.+-]{1,40}$"#, options: .regularExpression) != nil ? appVersion : "unknown"
        isEnabled = defaults.bool(forKey: Keys.enabled) // opt-in: false unless chosen
        load()
    }

    /// Random per installation; not derived from the device or your account.
    public var installationID: String {
        if let id = defaults.string(forKey: Keys.installation), UUID(uuidString: id) != nil { return id.lowercased() }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: Keys.installation)
        return id
    }

    /// Queues feedback for an entry. Returns false (and queues nothing) when sharing is off, the
    /// entry has no saved text, or the result wasn't assessed.
    @discardableResult
    public func enqueue(_ verdict: LocalReport.Verdict, for entry: HistoryEntry) -> Bool {
        guard isEnabled, let text = entry.text, text.count >= 10, let level = entry.riskLevel, let score = entry.riskScore else { return false }
        pending.removeAll { $0.historyEntryID == entry.id } // changing your mind replaces it
        pending.append(ContributionPayload(
            id: UUID(), historyEntryID: entry.id, installationId: installationID,
            text: String(text.prefix(2000)), verdict: verdict.rawValue,
            system: .init(riskLevel: level.rawValue, riskScore: score, category: entry.category),
            appVersion: appVersion, createdAt: Date()))
        if pending.count > Self.maxPending { pending.removeFirst(pending.count - Self.maxPending) }
        persist()
        return true
    }

    /// Sends queued items one by one; accepted ones are removed. Stops at the first failure.
    public func flush(using send: @Sendable (ContributionPayload) async -> SendResult) async {
        guard isEnabled, !sending else { return }
        sending = true
        defer { sending = false }
        for item in pending {
            switch await send(item) {
            case .accepted:
                pending.removeAll { $0.id == item.id }
                persist()
                lastStatus = "Shared \(item.createdAt.formatted(date: .abbreviated, time: .shortened))"
            case .notAccepted(let status):
                lastStatus = status == 403
                    ? "The ScamShield service isn't accepting contributions — they stay on this device."
                    : "The service declined a contribution (HTTP \(status)); it stays queued."
                return
            case .failed:
                lastStatus = "Couldn't reach the ScamShield service — will retry later."
                return
            }
        }
    }

    public func clear() {
        pending = []
        persist()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        pending = (try? d.decode([ContributionPayload].self, from: data)) ?? []
    }

    private func persist() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if pending.isEmpty {
                try? FileManager.default.removeItem(at: fileURL)
                return
            }
            let e = JSONEncoder()
            e.dateEncodingStrategy = .iso8601
            try e.encode(pending).write(to: fileURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            lastStatus = "Couldn't save queued contributions (\(error.localizedDescription))."
        }
    }
}

/// Sends a contribution to `<base>/api/v1/contributions`.
public struct ContributionSender: Sendable {
    public let baseURL: URL
    public let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func send(_ c: ContributionPayload) async -> ContributionOutbox.SendResult {
        var request = URLRequest(url: baseURL.appending(path: "api/v1/contributions"), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ScamShield-macOS/1", forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        guard let body = try? c.requestBody() else { return .failed }
        request.httpBody = body
        guard let (_, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else { return .failed }
        return (200...201).contains(http.statusCode) ? .accepted : .notAccepted(http.statusCode)
    }
}
