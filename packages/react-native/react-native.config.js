// Autolinking overrides. Without these, RN CLI infers the ReactPackage's import path from the
// Gradle `namespace` rather than from where the class lives, and generates an import that does
// not compile — the bridge classes deliberately sit one level down in `.bridge`, keeping the
// framework-free engine and the React-facing adapter in separate packages. Stating both also
// pins the contract across RN CLI versions, whose inference has changed more than once.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: "import com.groundcover.rum.bridge.GroundcoverRumPackage;",
        packageInstance: "new GroundcoverRumPackage()",
      },
    },
  },
};
