Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef VERSION
  !define VERSION "0.1.3"
!endif
Name "MUDU Host"
OutFile "${STAGE}\..\installers\MUDU-Host-Setup-${VERSION}-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\MUDU Host"
InstallDirRegKey HKCU "Software\MUDU\Host" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\MUDU Host.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open MUDU Host"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!define WEBVIEW2_CLIENT "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
Var WebViewVersion
Function DetectWebView
  StrCpy $WebViewVersion ""
  SetRegView 32
  ReadRegStr $WebViewVersion HKLM "${WEBVIEW2_CLIENT}" "pv"
  ${If} $WebViewVersion == ""
  ${OrIf} $WebViewVersion == "0.0.0.0"
    ReadRegStr $WebViewVersion HKCU "${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $WebViewVersion == ""
  ${OrIf} $WebViewVersion == "0.0.0.0"
    SetRegView 64
    ReadRegStr $WebViewVersion HKCU "${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  SetRegView 32
FunctionEnd
Function EnsureHostStopped
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\MUDUHostLauncher") p .r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK|MB_ICONEXCLAMATION "MUDU Host is running. Finish examinations and quit the Host from its tray icon before installing an update."
    Abort
  ${EndIf}
FunctionEnd
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "This installer requires 64-bit Windows."
    Abort
  ${EndIf}
  Call EnsureHostStopped
  ReadRegDWORD $0 HKLM "Software\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 394802
    MessageBox MB_OK|MB_ICONEXCLAMATION "MUDU Host requires .NET Framework 4.6.2 or newer. Install current Windows updates or .NET Framework 4.8, then run setup again."
    Abort
  ${EndIf}
FunctionEnd
Section "MUDU Host"
  Call EnsureHostStopped
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\MUDU Host" +3
    MessageBox MB_OK "Install MUDU Host in its dedicated per-user application folder."
    Abort
  Call DetectWebView
  ${If} $WebViewVersion == ""
  ${OrIf} $WebViewVersion == "0.0.0.0"
    DetailPrint "Installing Microsoft WebView2 for the MUDU interface..."
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=WebView2RuntimeInstaller.exe "${STAGE}\prerequisites\WebView2RuntimeInstaller.exe"
    ExecWait '"$PLUGINSDIR\WebView2RuntimeInstaller.exe" /silent /install' $0
    Call DetectWebView
    ${If} $WebViewVersion == ""
    ${OrIf} $WebViewVersion == "0.0.0.0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "WebView2 could not be installed. Finish installing Microsoft WebView2 Runtime, then run MUDU setup again. Saved examination data has not been changed."
      Abort
    ${EndIf}
  ${EndIf}
  ; Finish prerequisite setup before replacing any installed application files.
  SetOutPath "$INSTDIR"
  File /r /x WebView2RuntimeInstaller.exe "${STAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\MUDU"
  CreateShortcut "$SMPROGRAMS\MUDU\MUDU Host.lnk" "$INSTDIR\MUDU Host.exe"
  CreateShortcut "$DESKTOP\MUDU Host.lnk" "$INSTDIR\MUDU Host.exe"
  WriteRegStr HKCU "Software\MUDU\Host" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost" "DisplayName" "MUDU Host"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost" "NoRepair" 1
SectionEnd
Function un.onInit
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\MUDU Host" +2
    Abort
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\MUDUHostLauncher") p .r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK "Finish examinations and quit MUDU Host before uninstalling. Saved examination data will be kept."
    Abort
  ${EndIf}
FunctionEnd
Section "Uninstall"
  ; Remove only installed files. Never remove LocalAppData\MUDU\Host data.
  RMDir /r "$INSTDIR\apps"
  RMDir /r "$INSTDIR\packages"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\prerequisites"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\MUDU Host.exe"
  Delete "$INSTDIR\host-public.json"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\HOST-INSTALLATION.md"
  Delete "$INSTDIR\Microsoft.Web.WebView2.Core.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.WinForms.dll"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\desktop-dependencies.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\MUDU\MUDU Host.lnk"
  RMDir "$SMPROGRAMS\MUDU"
  Delete "$DESKTOP\MUDU Host.lnk"
  DeleteRegKey HKCU "Software\MUDU\Host"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MUDUHost"
SectionEnd
