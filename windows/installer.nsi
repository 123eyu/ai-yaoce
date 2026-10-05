Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "AI 遥测"
OutFile "..\release\windows-lite\ai-yaoce-2.0.0-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\ai-yaoce"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "2.0.0.0"
VIAddVersionKey "ProductName" "AI 遥测"
VIAddVersionKey "FileDescription" "AI 遥测 Windows 轻量版安装程序"
VIAddVersionKey "FileVersion" "2.0.0"
VIAddVersionKey "LegalCopyright" "MIT License"
!define MUI_ICON "..\build\windows-lite\app.ico"
!define MUI_UNICON "..\build\windows-lite\app.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetRegView 32
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 528040
    MessageBox MB_OK|MB_ICONSTOP ".NET Framework 4.8 或以上未安装。请通过 Windows Update 或微软官网安装后重试。本程序不会自动下载组件。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetRegView 64
  FindWindow $0 "" "AI 遥测"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "请先从托盘退出 AI 遥测，再运行安装程序。" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

Section "AI 遥测"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "..\release\windows-lite\app\ai-yaoce.exe"
  File "..\LICENSE"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\AI 遥测.lnk" "$INSTDIR\ai-yaoce.exe"
  CreateDirectory "$SMPROGRAMS\ai-yaoce"
  CreateShortcut "$SMPROGRAMS\ai-yaoce\AI 遥测.lnk" "$INSTDIR\ai-yaoce.exe"
  CreateShortcut "$SMPROGRAMS\ai-yaoce\卸载.lnk" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "DisplayName" "AI 遥测"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "DisplayVersion" "2.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "DisplayIcon" "$INSTDIR\ai-yaoce.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native" "NoRepair" 1
SectionEnd

Function un.onInit
  SetRegView 64
  FindWindow $0 "" "AI 遥测"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "请先从托盘退出 AI 遥测，再卸载。" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$INSTDIR\ai-yaoce.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\AI 遥测.lnk"
  Delete "$SMPROGRAMS\ai-yaoce\AI 遥测.lnk"
  Delete "$SMPROGRAMS\ai-yaoce\卸载.lnk"
  RMDir "$SMPROGRAMS\ai-yaoce"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-yaoce-native"
SectionEnd
