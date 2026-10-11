import Foundation
import Testing
@testable import ScamShieldCore

struct RedactorLinkTests {
    @Test func masksLinkPathsWithAndWithoutScheme() {
        let r = Redactor.redact("Update at sbi-kyc.top/verify?token=abc or https://x.in/a/b or www.y.com/p. Score 3.5/10, mail ravi@gmail.com")
        for leaked in ["/verify", "token=abc", "/a/b", "www.y.com/p"] { #expect(!r.contains(leaked), "\(leaked) leaked: \(r)") }
        #expect(r.contains("sbi-kyc.top/…") && r.contains("https://x.in/…"))
        #expect(r.contains("3.5/10")) // not a link
        #expect(r.contains("r***@gmail.com"))
    }

    @Test func masksNumbersAndHandles() {
        let r = Redactor.redact("OTP 482913, card 4111 1111 1111 1111, pay ravi@okaxis")
        for leaked in ["482913", "4111 1111", "ravi@okaxis"] { #expect(!r.contains(leaked)) }
    }
}
