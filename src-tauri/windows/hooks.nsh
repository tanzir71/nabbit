; Run the narrow, ownership-checked cleanup before removing the executable.
; The CLI path bypasses single-instance activation and never creates a window.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$INSTDIR\nabbit.exe"
      ClearErrors
      ExecWait '"$INSTDIR\nabbit.exe" --unregister-context' $0
      ${If} ${Errors}
        Abort "Nabbit context cleanup could not start. Close Nabbit and retry uninstalling."
      ${EndIf}
      ${If} $0 != 0
        Abort "Nabbit context cleanup failed. Close Nabbit and retry uninstalling."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
