Option Explicit
Dim shell, files, folder, executable, environment
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
executable = files.BuildPath(folder, "release\win-unpacked\Blue Hour.exe")

If Not files.FileExists(executable) Then
  executable = files.BuildPath(folder, "dist\win-unpacked\Blue Hour.exe")
End If

If files.FileExists(executable) Then
  Set environment = shell.Environment("Process")
  ' Development hosts may set this; the launcher always opens the desktop app.
  environment.Remove "ELECTRON_RUN_AS_NODE"
  If files.FileExists(files.BuildPath(folder, ".env")) Then
    environment("BLUE_HOUR_PRIVATE_ENV_FILE") = files.BuildPath(folder, ".env")
  End If
  shell.CurrentDirectory = folder
  shell.Run Chr(34) & executable & Chr(34), 1, False
Else
  MsgBox "The desktop application has not been built in this folder yet. Open the Blue Hour installer supplied with this project, then use Blue Hour from the Start menu.", vbInformation, "Blue Hour"
End If
