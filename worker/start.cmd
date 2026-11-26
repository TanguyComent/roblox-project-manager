@echo off
rem Lance le Worker avec une console visible (utile pour voir les erreurs). Pour un lancement discret : start.vbs
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning src/main.ts %*
pause
