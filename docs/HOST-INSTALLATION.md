# MUDU Host for Windows

## Lecturer experience

Install `MUDU-Host-Setup-0.1.3-x64.exe`, then open **MUDU Host** from the Start menu or desktop. The full MUDU interface opens inside a resizable Windows app using Microsoft WebView2. A startup screen remains visible until the local server and interface are ready. No terminal, development server or separate Node installation is required.

Closing the Host window leaves the examination server running in the system tray. Double-click the tray icon or select **Open MUDU** to return to the same interface and sign-in session. Use **Host → Quit Host** or the tray's **Quit Host** action only after examinations finish. Quitting requires confirmation and asks the server to finish its work before exiting. Automatic sleep is inhibited while the Host is running; this does not protect against power loss, manual sleep or shutdown.

The **View** menu provides Back, Forward and Reload interface, with Alt+Left, Alt+Right and Ctrl+R shortcuts. MUDU links that request another window open inside the app and share its profile. CSV exports and access-file downloads use a Windows save dialog. Ordinary external web links open in the default browser. The embedded browser cannot navigate to other services, open local files, execute shell protocols, or expose native host objects to page scripts.

If the interface fails, **Retry interface** reconnects it without restarting the examination server. **Open in browser** is an explicit fallback on that error screen. A failed local server instead shows a separate Host error and retry action; it never presents another process listening on a different address as this workspace.

The existing **Local delivery** workflow selects the router connection and displays the candidate address. Candidates still use their normal browsers. Windows may ask permission for local-network access; allow the examination network only, not arbitrary public networks. The installer does not create a broad firewall exception.

## Data and updates

Create one MUDU account and sign in; its private workspace is created automatically on this Host. On a fresh computer the first online administrator also becomes the Host operator. **Enable offline access** authorizes a trusted computer to unlock that same workspace with a device password. It does not create a second account. See [account and workspace behavior](ACCOUNT-WORKSPACE.md).

Records live in `%LOCALAPPDATA%\MUDU\Host`, outside the installation directory and OneDrive. The packaged Host uses the same data location as the development Host; do not run both together. Installing an update or uninstalling the application preserves this data.

The app's browser profile lives in the `WebView2` subfolder of that data directory. It preserves app cookies and local drafts through window closure and updates. It is separate from Chrome/Edge browser profiles, so signing in through an external browser does not automatically sign in inside the app. Password recovery emails may open in the external browser; after resetting, use the new connected password inside MUDU Host. Treat the browser profile as private account data.

Updates are explicit: finish examinations, quit the Host, and install the newer release. Setup refuses to replace a running desktop Host. There is no silent auto-update or automatic application restart during an examination. Do not downgrade a Host after a database migration.

## Developer release process

Windows x64 with .NET Framework 4.6.2 or newer and the Microsoft WebView2 Runtime is the initial supported platform (Windows 10/11 qualification is still required). Setup checks the .NET baseline. macOS/Linux installers are not implemented.

Run `npm run package:host`. The script builds the web application, installs locked production dependencies in a new staging directory, downloads a pinned official Node 24 runtime, verifies its published SHA-256, and compiles the native launcher. The pinned WebView2 SDK NuGet package is checked against a reviewed SHA-256 before extraction. Its managed assemblies, x64 native loader and license are bundled. Build dependencies are not needed on lecturers' computers.

The installer includes Microsoft's x64 Evergreen standalone WebView2 installer, verifies its Microsoft Authenticode signature during packaging, and installs it only when the runtime is absent. Initial setup can therefore work offline. `MUDU_WEBVIEW2_INSTALLER` can point to an already downloaded official standalone x64 installer; it is subject to the same signature verification. Refresh the cached installer when preparing a release. Its version and checksum are recorded in `desktop-dependencies.json`. Evergreen security updates take effect when the app next starts; MUDU does not restart an active examination to adopt an update.

To build the installer, extract the official NSIS 3.13 compiler into `.packaging/nsis`, or set `MUDU_MAKENSIS` to `makensis.exe`. Then run packaging again. The installer is written to `release/installers`. Run `node scripts/smoke-host.mjs` to test packaged startup, static assets, isolated storage, restart and shutdown. Run `node scripts/smoke-desktop.mjs` to exercise the actual WebView2 shell with isolated data, React rendering, navigation, in-app windows, export contents, close-to-tray and graceful shutdown. The tests do not access production examination data.

The package exports only the Supabase URL and publishable/legacy-anon key from the developer environment. It rejects privileged keys. It does **not** copy `.env`, PostgreSQL credentials, passwords, AI server keys or private TLS keys. Public cloud configuration allows existing cloud sign-in/synchronization; active prepared local examinations remain independent of the internet. The desktop package is not the publicly hosted online examination backend.

AI credentials are not distributed to lecturers. An optional operator-controlled `host.env` in the data directory can supply `MUDU_GOOGLE_AI_KEY` for a managed Host. A centrally hosted AI service is a separate deployment concern.

## Release gates

This initial installer is unsigned. Windows SmartScreen warnings are possible; code signing and a trusted HTTPS release channel are required before broad distribution. Do not advise users to disable antivirus or security protections. Real Windows install/update/uninstall, tray/keyboard accessibility, router/firewall and power-interruption walkthroughs remain required before production release.

The bundled runtime and dependencies must be reviewed and patched on each release. No automatic download-and-execute updater is included. Keep the installer version increasing and publish checksums alongside trusted release files.
