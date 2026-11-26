' Lance le Worker sans fenetre : l'interface locale s'ouvre dans le navigateur.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node --disable-warning=ExperimentalWarning src/main.ts", 0, False
