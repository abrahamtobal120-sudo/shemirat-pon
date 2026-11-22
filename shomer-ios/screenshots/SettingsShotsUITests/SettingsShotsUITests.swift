import XCTest
import UIKit

/// Drives the real iOS Settings app (com.apple.Preferences) through the Screen Time
/// steps of the install guide and saves a screenshot at each step.
/// Every step is best-effort: a missing label is logged and the run continues.
final class SettingsShotsUITests: XCTestCase {
    var app: XCUIApplication!
    var dir = NSTemporaryDirectory()
    var prefix = "ios"
    var dbg = 0
    var log = ""

    override func setUp() {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        if let d = env["SHOTS_DIR"], !d.isEmpty { dir = d }
        if let p = env["SHOTS_PREFIX"], !p.isEmpty { prefix = p }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        app = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        app.launchArguments = ["-AppleLanguages", "(es-MX)", "-AppleLocale", "es_MX"]
    }

    override func tearDown() {
        note("done")
        try? log.write(toFile: "\(dir)/\(prefix)-log.txt", atomically: true, encoding: .utf8)
    }

    // MARK: helpers

    func note(_ s: String) {
        log += s + "\n"
        print("SHOTS: \(s)")
    }

    func save(_ name: String) {
        sleep(1)
        let shot = XCUIScreen.main.screenshot()
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        let att = XCTAttachment(screenshot: shot)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
        try? app.debugDescription.write(toFile: "\(dir)/\(name).txt", atomically: true, encoding: .utf8)
        note("saved \(name)")
    }

    func debugShot(_ what: String) {
        dbg += 1
        save(String(format: "%@-dbg-%02d-%@", prefix, dbg, what))
    }

    /// Visible scroll containers; main = leftmost (sidebar on iPad), detail = rightmost.
    func container(main: Bool) -> XCUIElement? {
        var all: [XCUIElement] = []
        all += app.collectionViews.allElementsBoundByIndex
        all += app.tables.allElementsBoundByIndex
        let vis = all.filter { $0.exists && $0.frame.width > 150 && $0.frame.height > 200 }
        if vis.isEmpty { return nil }
        return main ? vis.min(by: { $0.frame.minX < $1.frame.minX })
                    : vis.max(by: { $0.frame.minX < $1.frame.minX })
    }

    func predicate(_ labels: [String]) -> NSPredicate {
        let subs = labels.map { NSPredicate(format: "label ==[c] %@", $0) }
        return NSCompoundPredicate(orPredicateWithSubpredicates: subs)
    }

    func findNow(_ labels: [String], in root: XCUIElement? = nil) -> XCUIElement? {
        let base: XCUIElement = root ?? app
        let p = predicate(labels)
        for q in [base.cells.matching(p), base.switches.matching(p), base.buttons.matching(p),
                  base.staticTexts.matching(p), base.cells.containing(p)] {
            for e in q.allElementsBoundByIndex where e.exists && e.isHittable {
                return e
            }
        }
        return nil
    }

    func drag(_ c: XCUIElement, up: Bool) {
        let a = c.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.75 : 0.3))
        let b = c.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.35 : 0.8))
        a.press(forDuration: 0.05, thenDragTo: b)
        sleep(1)
    }

    /// Find a hittable element by label, scrolling the chosen pane down (and then up) if needed.
    func find(_ labels: [String], main: Bool = false, swipes: Int = 8) -> XCUIElement? {
        if let e = findNow(labels) { return e }
        for up in [true, false] {
            for _ in 0..<swipes {
                guard let c = container(main: main) else { break }
                drag(c, up: up)
                if let e = findNow(labels) { return e }
            }
        }
        note("NOT FOUND: \(labels)")
        return nil
    }

    @discardableResult
    func tap(_ labels: [String], main: Bool = false) -> Bool {
        guard let e = find(labels, main: main) else { return false }
        note("tap '\(e.label)' type=\(e.elementType.rawValue)")
        e.tap()
        sleep(2)
        return true
    }

    /// Bring an element fully into view (not hidden under nav bar / bottom edge).
    func settle(_ e: XCUIElement, main: Bool = false) {
        let screenH = app.frame.height
        for _ in 0..<3 {
            if e.exists && e.frame.maxY > screenH * 0.95, let c = container(main: main) { drag(c, up: true) } else { break }
        }
    }

    func back() {
        // On iPad pick the detail (rightmost) navigation bar, never the sidebar.
        let bars = app.navigationBars.allElementsBoundByIndex.filter { $0.exists && $0.frame.width > 100 }
        guard let bar = bars.max(by: { $0.frame.minX < $1.frame.minX }) else { return }
        let b = bar.buttons.element(boundBy: 0)
        if b.exists && b.isHittable {
            note("back '\(b.label)'")
            b.tap()
            sleep(2)
        }
    }

    // MARK: the flow

    let screenTime = ["Tiempo en pantalla", "Tiempo de pantalla", "Screen Time"]
    let cpr = ["Restricciones de contenido y privacidad", "Contenido y privacidad", "Content & Privacy Restrictions"]
    let onboarding = ["Activar Tiempo en pantalla", "Activar Tiempo de pantalla", "Turn On Screen Time",
                      "Continuar", "Continue",
                      "Este es mi iPhone", "Este es mi iPad", "This is My iPhone", "This is My iPad"]
    let contentRestr = ["App Store, contenido, Internet y juegos", "Restricciones de contenido", "Content Restrictions",
                        "Tiendas, web, Siri y Game Center", "Store, Web, Siri & Game Center Content"]
    let webContent = ["Contenido web", "Contenido de Internet", "Internet", "Sitios web", "Web Content"]
    let limitAdult = ["Limitar sitios web para adultos", "Limitar sitios para adultos", "Limit Adult Websites"]
    let passcode = ["Bloquear configuración", "Usar código de Tiempo en pantalla", "Usar código de Tiempo de pantalla",
                    "Usar código para Tiempo en pantalla", "Use Screen Time Passcode"]

    func testCaptureScreenTimeFlow() {
        let dev = UIDevice.current
        note("device model=\(dev.model) name=\(dev.name) system=\(dev.systemName) \(dev.systemVersion)")
        note("locale=\(Locale.current.identifier) languages=\(Locale.preferredLanguages)")

        app.launch()
        sleep(3)
        debugShot("launch")

        // 1. Settings main list with "Tiempo en pantalla"
        if let st = find(screenTime, main: true) {
            settle(st, main: true)
            note("found main row '\(st.label)'")
            save("\(prefix)-1-tiempo-pantalla")
            st.tap()
            sleep(3)
        }
        debugShot("screen-time-page")

        // First-run flow, if any
        for i in 0..<5 {
            if findNow(cpr) != nil { break }
            guard let b = findNow(onboarding) else { break }
            note("onboarding tap '\(b.label)'")
            b.tap()
            sleep(3)
            save("\(prefix)-0\(i + 1)-onboarding")
        }

        // 2. Screen Time page showing the restrictions row
        if let row = find(cpr) {
            settle(row)
            save("\(prefix)-2-restricciones")
            row.tap()
            sleep(3)
        }
        debugShot("cpr-page")

        // 3. Main switch ON
        let sw = app.switches.matching(predicate(cpr)).firstMatch.exists
            ? app.switches.matching(predicate(cpr)).firstMatch
            : app.switches.firstMatch
        if sw.exists {
            note("switch '\(sw.label)' value=\(String(describing: sw.value))")
            if (sw.value as? String) != "1" {
                // tap the switch control itself (right side)
                sw.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
                sleep(2)
            }
            note("switch now value=\(String(describing: sw.value))")
            save("\(prefix)-3-restricciones-on")
        } else {
            note("NO SWITCH on cpr page")
        }

        // 4. Content restrictions -> Web content -> Limit adult websites
        if tap(contentRestr) {
            debugShot("content-restrictions")
            if tap(webContent) {
                debugShot("web-content-before")
                if let l = find(limitAdult) {
                    l.tap()
                    sleep(2)
                    debugShot("web-content-after-tap")
                    // Show the whole page from the top
                    if let c = container(main: false) { drag(c, up: false); drag(c, up: false) }
                    save("\(prefix)-4-contenido-web")
                }
            }
        }

        // 5. Back to Screen Time page, show passcode row
        for _ in 0..<4 {
            if findNow(passcode) != nil { break }
            if app.navigationBars.matching(predicate(screenTime)).firstMatch.exists, find(passcode, swipes: 6) != nil { break }
            back()
        }
        debugShot("back-to-screen-time")
        if let p = find(passcode) {
            settle(p)
            save("\(prefix)-5-codigo")
            p.tap()
            sleep(3)
            debugShot("passcode-tapped")
        }
    }
}
