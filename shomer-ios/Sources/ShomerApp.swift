import SwiftUI
import FamilyControls
import ManagedSettings

/// Where Shomer applies its restrictions.
enum ProtectionScope: String, CaseIterable, Identifiable {
    /// Adult-website filter in Safari and every app that shows web pages (WebKit).
    case browsers
    /// Browser filter plus blocked apps/categories and explicit media in Apple apps.
    case wholePhone

    var id: String { rawValue }

    var title: String {
        switch self {
        case .browsers: return "Solo navegador"
        case .wholePhone: return "Todo el teléfono"
        }
    }

    var detail: String {
        switch self {
        case .browsers:
            return "Filtra sitios para adultos en Safari, Chrome y en las páginas web que se abren dentro de otras apps."
        case .wholePhone:
            return "Además del filtro web, bloquea las apps y categorías que elijas y el contenido explícito de música, podcasts y libros de Apple."
        }
    }
}

@main
struct ShomerApp: App {
    var body: some Scene {
        WindowGroup { ProtectionView() }
    }
}

struct ProtectionView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: FamilyActivitySelection
    @State private var canPersistSelection: Bool
    @State private var selectionLoadFailed: Bool
    @State private var hasNewSelectionAfterLoadFailure: Bool
    @State private var persistenceMessage: String?
    @State private var authorizationStatus = AuthorizationCenter.shared.authorizationStatus
    @State private var showingPicker = false
    @AppStorage("protectionScope") private var scopeValue = ProtectionScope.wholePhone.rawValue
    @AppStorage("denyAppRemoval") private var denyAppRemoval = false
    @State private var message = "Elige apps, categorías o dominios y aplica el bloqueo cuando quieras."
    private let store = ManagedSettingsStore()

    init() {
        let savedSelection = SelectionPersistence.load()
        _selection = State(initialValue: savedSelection.selection)
        _canPersistSelection = State(initialValue: savedSelection.canPersist)
        _selectionLoadFailed = State(initialValue: savedSelection.loadFailed)
        _hasNewSelectionAfterLoadFailure = State(initialValue: false)
        _persistenceMessage = State(initialValue: savedSelection.message)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("¿Dónde quieres filtrar?") {
                    Picker("Modo", selection: $scopeValue) {
                        ForEach(ProtectionScope.allCases) { scope in
                            Text(scope.title).tag(scope.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text(scope.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if scope == .wholePhone {
                        Toggle("Impedir que se borren apps (protege Shomer)", isOn: $denyAppRemoval)
                    }
                }
                Section("Protección del dispositivo") {
                    Text("Shomer pide al sistema que aplique el filtro de sitios para adultos de Apple y, en modo «Todo el teléfono», que bloquee las apps, categorías y dominios elegidos. No analiza ni cubre imágenes dentro de otras apps.")
                    LabeledContent("Autorización", value: authorizationDescription)
                    LabeledContent("Selección guardada", value: selectionDescription)

                    Button("Autorizar acceso") {
                        Task { await requestAuthorization() }
                    }
                    Button(scope == .wholePhone ? "Elegir apps, categorías y sitios" : "Elegir sitios para bloquear") { showingPicker = true }
                        .disabled(authorizationStatus != .approved)
                    Button("Aplicar bloqueo") {
                        guard authorizationStatus == .approved else {
                            message = "Autoriza el acceso antes de aplicar el bloqueo."
                            return
                        }
                        applySelection()
                    }
                    .disabled(selectionLoadFailed && !hasNewSelectionAfterLoadFailure)
                    Button("Quitar bloqueo") {
                        store.clearAllSettings()
                        message = "Se solicitó al sistema quitar las restricciones de Shomer."
                    }
                }
                Section {
                    Text(message)
                    if let persistenceMessage {
                        Label(persistenceMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Shomer")
            .familyActivityPicker(isPresented: $showingPicker, selection: $selection)
            .onAppear(perform: refreshAuthorizationStatus)
            .onChange(of: scenePhase) { phase in
                if phase == .active {
                    refreshAuthorizationStatus()
                }
            }
            .onChange(of: selection) { updatedSelection in
                if selectionLoadFailed {
                    hasNewSelectionAfterLoadFailure = true
                }
                guard canPersistSelection else { return }
                do {
                    try SelectionPersistence.save(updatedSelection)
                    persistenceMessage = nil
                } catch {
                    persistenceMessage = "No se pudo guardar la selección. Los datos guardados previamente se conservaron. \(error.localizedDescription)"
                }
            }
        }
    }

    private var scope: ProtectionScope {
        ProtectionScope(rawValue: scopeValue) ?? .wholePhone
    }

    private var authorizationDescription: String {
        switch authorizationStatus {
        case .approved:
            return "Autorizada"
        case .denied:
            return "Denegada"
        case .notDetermined:
            return "Aún no solicitada"
        @unknown default:
            return "Desconocida"
        }
    }

    private var selectionDescription: String {
        if selectionLoadFailed {
            if hasNewSelectionAfterLoadFailure {
                return "Nueva selección (no guardada)"
            }
            return "No disponible (error de lectura)"
        }
        if persistenceMessage != nil {
            return "No guardada (error de escritura)"
        }
        let count = selection.applicationTokens.count
            + selection.categoryTokens.count
            + selection.webDomainTokens.count
        return count == 0 ? "Ninguna" : "\(count) elementos"
    }

    @MainActor
    private func requestAuthorization() async {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            refreshAuthorizationStatus()
            message = authorizationStatus == .approved
                ? "Autorización concedida. Ya puedes elegir apps, categorías y dominios."
                : "La autorización no está activa. Comprueba el estado e inténtalo de nuevo si procede."
        } catch {
            refreshAuthorizationStatus()
            message = "No se pudo obtener autorización. Comprueba el estado e inténtalo de nuevo si procede."
        }
    }

    private func refreshAuthorizationStatus() {
        authorizationStatus = AuthorizationCenter.shared.authorizationStatus
    }

    private func applySelection() {
        // Apple's adult-website filter: applies to Safari and every app that uses WebKit.
        store.webContent.blockedByFilter = .auto()
        store.shield.webDomains = selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens

        if scope == .wholePhone {
            store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
            store.shield.applicationCategories = selection.categoryTokens.isEmpty ? nil : .specific(selection.categoryTokens)
            store.media.denyExplicitContent = true
            store.application.denyAppRemoval = denyAppRemoval ? true : nil
            message = "Filtro web, apps elegidas y contenido explícito enviados al sistema. Comprueba el bloqueo en el dispositivo."
        } else {
            store.shield.applications = nil
            store.shield.applicationCategories = nil
            store.media.denyExplicitContent = nil
            store.application.denyAppRemoval = nil
            message = "Filtro de sitios para adultos enviado al sistema para Safari y las páginas web de otras apps. Compruébalo en el dispositivo."
        }
    }
}

private enum SelectionPersistence {
    private static let key = "familyActivitySelection"

    struct LoadResult {
        let selection: FamilyActivitySelection
        let canPersist: Bool
        let loadFailed: Bool
        let message: String?
    }

    static func load() -> LoadResult {
        guard let data = UserDefaults.standard.data(forKey: key) else {
            return LoadResult(
                selection: FamilyActivitySelection(),
                canPersist: true,
                loadFailed: false,
                message: nil
            )
        }

        do {
            let selection = try JSONDecoder().decode(FamilyActivitySelection.self, from: data)
            return LoadResult(
                selection: selection,
                canPersist: true,
                loadFailed: false,
                message: nil
            )
        } catch {
            return LoadResult(
                selection: FamilyActivitySelection(),
                canPersist: false,
                loadFailed: true,
                message: "No se pudo leer la selección guardada; los datos originales se conservaron y no se sobrescribirán. \(error.localizedDescription)"
            )
        }
    }

    static func save(_ selection: FamilyActivitySelection) throws {
        let data = try JSONEncoder().encode(selection)
        UserDefaults.standard.set(data, forKey: key)
    }
}
