import SwiftUI
import FamilyControls
import ManagedSettings

@main
struct ShomerApp: App {
    var body: some Scene {
        WindowGroup { ProtectionView() }
    }
}

struct ProtectionView: View {
    @State private var selection = FamilyActivitySelection()
    @State private var showingPicker = false
    @State private var message = "Autoriza Shomer para elegir aplicaciones."
    private let store = ManagedSettingsStore()

    var body: some View {
        NavigationStack {
            Form {
                Section("Protección del dispositivo") {
                    Text("Bloquea las aplicaciones que selecciones. El filtrado de imágenes dentro de otras apps no está disponible.")
                    Button("Autorizar acceso") {
                        Task { @MainActor in
                            do {
                                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                                message = "Permiso concedido. Puedes elegir aplicaciones."
                            } catch {
                                message = "No se concedió el permiso. Puedes volver a intentarlo."
                            }
                        }
                    }
                    Button("Elegir aplicaciones") { showingPicker = true }
                        .disabled(AuthorizationCenter.shared.authorizationStatus != .approved)
                    Button("Aplicar bloqueo") {
                        guard AuthorizationCenter.shared.authorizationStatus == .approved else {
                            message = "Autoriza el acceso antes de aplicar el bloqueo."
                            return
                        }
                        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
                        store.shield.applicationCategories = selection.categoryTokens.isEmpty ? nil : .specific(selection.categoryTokens)
                        store.shield.webDomains = selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens
                        message = "Configuración enviada al sistema. Comprueba las aplicaciones seleccionadas."
                    }
                    Button("Quitar bloqueo") {
                        store.clearAllSettings()
                        message = "Se retiraron las restricciones de Shomer."
                    }
                }
                Section { Text(message) }
            }
            .navigationTitle("Shomer")
            .familyActivityPicker(isPresented: $showingPicker, selection: $selection)
        }
    }
}
